import pg from 'pg';
export async function preflight(env,client){
 const checks=[];const add=(name,ok)=>checks.push({name,ok:!!ok});
 for(const name of ['DATABASE_URL','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','BOOKING_FROM','ADMIN_SECRET','CRON_SECRET'])add(name+' configured',String(env[name]||'').trim());
 add('Real publishing mode',env.PUBLISH_TEST_MODE==='0');add('Stripe billing mode',env.PAYWALL_MODE==='stripe');
 let origin;try{origin=new URL(env.PUBLIC_ORIGIN);}catch{}
 add('Public origin is an HTTPS origin',origin?.protocol==='https:'&&!origin.username&&!origin.password&&origin.pathname==='/'&&!origin.search&&!origin.hash);
 const warnings=[];
 if(client){
  try{
   const schema=(await client.query("SELECT to_regclass('public.hb_kv') AS name")).rows[0]?.name;add('Transactional state table exists',!!schema);
   if(schema){const counts=await client.query("SELECT count(*) FILTER (WHERE starts_with(key,'mailqueue/'))::int AS pending_mail, count(*) FILTER (WHERE starts_with(key,'accounts/'))::int AS accounts FROM hb_kv");warnings.push({name:'Stored state summary',accounts:counts.rows[0].accounts,pendingMail:counts.rows[0].pending_mail});}
  }catch{add('Database readable',false);}
 }else add('Database verified',false);
 return {ok:checks.every(x=>x.ok),checks,warnings,remaining:['Confirm migration counts against backup','Verify actual CSP and booking on preview','Run isolated two-pool database test','Confirm cron invocation and email delivery']};
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){
 let pool,client;
 try{if(process.env.DATABASE_URL){pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});client=await pool.connect();}const result=await preflight(process.env,client);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}catch{console.error('Deployment preflight failed. No configuration values or credentials are logged.');process.exitCode=1;}finally{client?.release();await pool?.end();}
}
