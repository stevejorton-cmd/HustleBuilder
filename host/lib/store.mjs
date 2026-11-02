import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
let override = null, cached = null;
const queues = new WeakMap();

function validKey(key) {
  if (typeof key !== 'string' || !key || key.split('/').some(p => !p || p === '.' || p === '..') || key.includes('\\') || key.includes('\0')) throw new Error('Invalid storage key');
  return key;
}
export function fileStore(root) {
  const file = key => path.join(root, ...validKey(key).split('/'));
  return {
    localOnly: true,
    async get(key) { try { return await readFile(file(key), 'utf8'); } catch(e) { if(e.code==='ENOENT') return null; throw e; } },
    async put(key,text) { const p=file(key);await mkdir(path.dirname(p),{recursive:true});const temp=p+'.tmp-'+randomBytes(8).toString('hex');try{await writeFile(temp,text);await rename(temp,p);}finally{await rm(temp,{force:true});} },
    async del(key) { await rm(file(key),{force:true}); },
    async list(prefix='') {
      const keys=[];
      async function walk(dir,base='') { let names;try{names=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}for(const n of names){const k=base+n.name;if(n.isDirectory())await walk(path.join(dir,n.name),k+'/');else if(!n.name.includes('.tmp-')&&k.startsWith(prefix))keys.push(k);} }
      await walk(root);return keys;
    }
  };
}
export async function blobStore() {
  const {put,list,del,get}=await import('@vercel/blob');
  return {
    legacyReadOnly:true,
    async get(key) { const r=await get(validKey(key),{access:'private',useCache:false});if(!r||r.statusCode!==200||!r.stream)return null;return new Response(r.stream).text(); },
    async put(){throw new Error('Blob writes disabled: migrate to transactional storage');},
    async del(){throw new Error('Blob writes disabled: migrate to transactional storage');},
    async list(prefix=''){const keys=[];let cursor;do{const r=await list({prefix,cursor,limit:1000});keys.push(...r.blobs.map(b=>b.pathname));cursor=r.hasMore?r.cursor:undefined;}while(cursor);return keys;}
  };
}
export function setStore(value){override=value;}
export async function store(){
  if(context.getStore())return context.getStore();
  if(override)return override;
  if(!cached){if(process.env.DATABASE_URL){const {postgresStore}=await import('./postgres-store.mjs');cached=await postgresStore(process.env.DATABASE_URL);}else cached=process.env.BLOB_READ_WRITE_TOKEN?await blobStore():fileStore(process.env.HB_STORE_DIR||'.hb-data');}
  return cached;
}
export async function transaction(fn, options={}) {
  if(context.getStore())return fn();
  const base=await store();
  if(base.transaction)return base.transaction(tx=>context.run(tx,fn),options);
  if(!override && process.env.PUBLISH_TEST_MODE!=='1')throw new Error('Transactional database required');
  if(options.readOnly)return context.run(base,fn);
  // Dev/test adapter only. Production never uses this process-local queue.
  const prev=queues.get(base)||Promise.resolve();let release;const next=new Promise(r=>release=r);queues.set(base,next);
  await prev;
  const pending=new Map(), original=new Map();
  const tx={
    async get(k){validKey(k);return pending.has(k)?pending.get(k):base.get(k);},
    async put(k,v){validKey(k);pending.set(k,v);},
    async del(k){validKey(k);pending.set(k,null);},
    async list(prefix=''){const list=base.list?await base.list(prefix):[];return [...new Set([...list,...pending.keys()])].filter(k=>k.startsWith(prefix)&&pending.get(k)!==null);}
  };
  try{
    const result=await context.run(tx,fn);
    for(const k of pending.keys())original.set(k,await base.get(k));
    try{for(const [k,v] of pending)v===null?await base.del(k):await base.put(k,v);}
    catch(error){for(const [k,v]of original){try{v===null?await base.del(k):await base.put(k,v);}catch{/* dev/test: preserve original error */}}throw error;}
    return result;
  }finally{release();}
}
