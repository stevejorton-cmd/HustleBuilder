import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomBytes} from 'node:crypto';
import {store,transaction} from './store.mjs';
const requests=new AsyncLocalStorage();
const sha=v=>createHash('sha256').update(String(v)).digest('hex');
export const withMailBatch=fn=>requests.run([],async()=>{const result=await fn();return {result,ids:requests.getStore()};});
export async function queueMail(message){
  const id=randomBytes(20).toString('hex');
  await (await store()).put('mailqueue/'+id+'.json',JSON.stringify({...message,id,createdAt:Date.now(),attempts:0}));
  requests.getStore()?.push(id);
  return {ok:true,queued:true,test:process.env.PUBLISH_TEST_MODE==='1'};
}
export async function flushMail(ids){
  const base=await store();
  if(!ids){
    let keys;
    if(base.dueMail)keys=await base.dueMail(100);
    else{
      const due=[];
      for(const key of await base.list('mailqueue/')){try{const m=JSON.parse(await base.get(key));if(!(m.nextAttemptAt>Date.now()))due.push({key,at:m.lastAttemptAt||0});}catch{/* Skip damaged items without logging their contents. */}}
      keys=due.sort((a,b)=>a.at-b.at||a.key.localeCompare(b.key)).slice(0,100).map(x=>x.key);
    }
    ids=keys.map(k=>k.slice(10,-5));
  }
  const deadline=Date.now()+20_000;
  for(const id of ids){
    if(Date.now()>=deadline)break;
    try{await transaction(async()=>{
      const s=await store(),key='mailqueue/'+id+'.json';const raw=await s.get(key);if(!raw)return;
      const m=JSON.parse(raw);
      if(Date.now()-m.createdAt>30*864e5 || m.expiresAt && m.expiresAt<=Date.now()){await s.del(key);return;}
      if(m.nextAttemptAt>Date.now())return;
      if(process.env.PUBLISH_TEST_MODE==='1'){
        const k='outbox/'+sha(m.to)+'.json',rows=JSON.parse(await s.get(k)||'[]');
        rows.push({at:new Date().toISOString(),...m});await s.put(k,JSON.stringify(rows.slice(-20)));await s.del(key);return;
      }
      if(!process.env.RESEND_API_KEY||!process.env.BOOKING_FROM)return;
      const payload={from:process.env.BOOKING_FROM,to:[m.to],subject:m.subject,text:m.text};
      if(m.html)payload.html=m.html;if(m.replyTo)payload.reply_to=m.replyTo;
      if(m.ics)payload.attachments=[{filename:'booking.ics',content:Buffer.from(m.ics).toString('base64')}];
      let response;
      try{response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'hb-mail-'+id},body:JSON.stringify(payload),signal:AbortSignal.timeout(Math.min(8000,Math.max(1,deadline-Date.now())))});}catch{/* Persist retry backoff even when the provider connection times out. */}
      if(response?.ok){await s.del(key);return;}
      m.lastAttemptAt=Date.now();m.attempts++;m.nextAttemptAt=Date.now()+Math.min(3600000,30000*2**Math.min(m.attempts,7));await s.put(key,JSON.stringify(m));
    },{keys:['mail:'+id]});}catch{/* Durable queue is retried by cron. No delivery payloads or secrets in logs. */}
  }
}
