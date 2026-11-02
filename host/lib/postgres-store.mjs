import pg from 'pg';
import {createHash} from 'node:crypto';
const {Pool}=pg;
const lockId=value=>createHash('sha256').update(value).digest().readBigInt64BE().toString();
export const SCHEMA=`CREATE TABLE IF NOT EXISTS hb_kv (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`;
export function postgresStore(connectionString, injectedPool) {
  const pool=injectedPool||new Pool({connectionString,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:10000});
  pool.on?.('error',()=>{}); // Never log connection strings or credentials.
  const adapter=client=>({
    async get(key){return (await client.query('SELECT value FROM hb_kv WHERE key=$1',[key])).rows[0]?.value??null;},
    async put(key,value){await client.query('INSERT INTO hb_kv(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()',[key,value]);},
    async del(key){await client.query('DELETE FROM hb_kv WHERE key=$1',[key]);},
    async incrementView(slug,day,cutoff){
      await client.query(`INSERT INTO hb_kv(key,value) VALUES($1,jsonb_build_object('total',1,'days',jsonb_build_object($2::text,1))::text)
        ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object(
          'total',COALESCE((hb_kv.value::jsonb->>'total')::bigint,0)+1,
          'days',(SELECT COALESCE(jsonb_object_agg(e.key,e.value),'{}'::jsonb) FROM jsonb_each(COALESCE(hb_kv.value::jsonb->'days','{}'::jsonb)||jsonb_build_object($2::text,COALESCE((hb_kv.value::jsonb->'days'->>$2)::bigint,0)+1)) e WHERE e.key >= $3)
        )::text, updated_at=now()`,['views/'+slug+'.json',day,cutoff]);
    },
    async dueMail(limit=100,now=Date.now()){return (await client.query("SELECT key FROM hb_kv WHERE starts_with(key,'mailqueue/') AND COALESCE((value::jsonb->>'nextAttemptAt')::bigint,0)<=$1 ORDER BY COALESCE((value::jsonb->>'lastAttemptAt')::bigint,0), key LIMIT $2",[now,limit])).rows.map(r=>r.key);},
    async list(prefix=''){return (await client.query('SELECT key FROM hb_kv WHERE starts_with(key,$1) ORDER BY key',[prefix])).rows.map(r=>r.key);}
  });
  return {
    ...adapter(pool),
    async transaction(fn,{keys=[],maintenance=false,readOnly=false}={}){
      const client=await pool.connect();
      try{
        await client.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        if(!readOnly){
          // Maintenance blocks mutations across instances; normal requests share this gate.
          await client.query(maintenance?'SELECT pg_advisory_xact_lock($1::bigint)':'SELECT pg_advisory_xact_lock_shared($1::bigint)',[lockId('hb:maintenance')]);
          for(const key of [...new Set(keys)].sort())await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[lockId('hb:'+key)]);
        }
        const result=await fn(adapter(client));
        await client.query('COMMIT');return result;
      }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
    },
    async close(){await pool.end();}
  };
}
