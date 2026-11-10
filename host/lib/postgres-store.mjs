import pg from 'pg';
import {createHash} from 'node:crypto';
const {Pool}=pg;
const lockId=value=>createHash('sha256').update(value).digest().readBigInt64BE().toString();
// The second index lets every "keys under this prefix" lookup (starts_with)
// use an index whatever the database's collation, instead of scanning the
// whole table as it grows.
export const SCHEMA=`CREATE TABLE IF NOT EXISTS hb_kv (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`;
export const PREFIX_INDEX=`CREATE INDEX IF NOT EXISTS hb_kv_key_prefix ON hb_kv (key text_pattern_ops);`;
const LEGACY_COUNTERS=['iplimit/','authem/','authip/','askem/','askip/','draftnew/','reportip/','adminip/'];
export function postgresStore(connectionString, injectedPool) {
  const pool=injectedPool||new Pool({connectionString,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:10000});
  pool.on?.('error',()=>{}); // Never log connection strings or credentials.
  // A brand-new database (a preview branch, a restored backup) has no table
  // until the migration runs. Create it on first use so the app can boot
  // against an empty database; the statement is idempotent, and a failure
  // clears the memo so the next call retries.
  let schemaPromise=null;
  const ensureSchema=()=>{if(!schemaPromise)schemaPromise=pool.query(SCHEMA).then(()=>pool.query(PREFIX_INDEX)).catch(error=>{schemaPromise=null;throw error;});return schemaPromise;};
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
    async list(prefix=''){return (await client.query('SELECT key FROM hb_kv WHERE starts_with(key,$1) ORDER BY key',[prefix])).rows.map(r=>r.key);},
    // Many small records in one round trip (the admin view reads every
    // account and page record). suffix keeps large siblings out: page HTML
    // lives beside page records under the same prefix.
    async entries(prefix='',suffix=''){return (await client.query('SELECT key,value FROM hb_kv WHERE starts_with(key,$1) AND right(key,length($2))=$2 ORDER BY key',[prefix,suffix])).rows.map(r=>[r.key,r.value]);},
    async sumArrayLengths(prefix){return Number((await client.query("SELECT COALESCE(sum(CASE WHEN value IS JSON ARRAY THEN jsonb_array_length(value::jsonb) ELSE 0 END),0) AS n FROM hb_kv WHERE starts_with(key,$1)",[prefix])).rows[0].n)||0;},
    // Expired housekeeping in one statement, by each row's last write time —
    // no record is read back. Ages mirror the app's own rules: sign-in and
    // abuse counters a day, admin sessions 12 hours, ask links 7 days,
    // cancel links and booking de-duplication 30 days, drafts 90 days. (A
    // row's clock restarts if it is rewritten, e.g. by a restore; records
    // are also checked against their own dates when they are read.)
    async sweep({keepFrom}){
      const r=await client.query(`DELETE FROM hb_kv WHERE
        (starts_with(key,'counters/') AND key < $1)
        OR EXISTS (SELECT 1 FROM unnest($2::text[]) AS legacy(prefix) WHERE starts_with(hb_kv.key,legacy.prefix))
        OR (starts_with(key,'adminsessions/') AND updated_at < now() - interval '12 hours')
        OR ((starts_with(key,'asks/') OR starts_with(key,'askby/')) AND updated_at < now() - interval '7 days')
        OR ((starts_with(key,'cancels/') OR starts_with(key,'bookingids/')) AND updated_at < now() - interval '30 days')
        OR ((starts_with(key,'drafts/') OR starts_with(key,'draftby/')) AND updated_at < now() - interval '90 days')`,['counters/'+keepFrom,LEGACY_COUNTERS]);
      return r.rowCount||0;
    }
  });
  const base=adapter(pool);
  const withSchema=fn=>async(...args)=>{await ensureSchema();return fn(...args);};
  return {
    get:withSchema(base.get),
    put:withSchema(base.put),
    del:withSchema(base.del),
    incrementView:withSchema(base.incrementView),
    dueMail:withSchema(base.dueMail),
    list:withSchema(base.list),
    entries:withSchema(base.entries),
    sumArrayLengths:withSchema(base.sumArrayLengths),
    sweep:withSchema(base.sweep),
    async transaction(fn,{keys=[],maintenance=false,readOnly=false}={}){
      await ensureSchema();
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
