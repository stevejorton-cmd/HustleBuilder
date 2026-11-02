import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {tmpdir} from 'node:os';
const root=new URL('../',import.meta.url).pathname;
const dir=await mkdtemp(tmpdir()+'/hb-http-');
const port=18977, base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['host/dev-server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HB_STORE_DIR:dir,PUBLISH_TEST_MODE:'1',PAYWALL_MODE:'test',PUBLIC_ORIGIN:base},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',d=>stderr+=d.toString());
const results=[];
try{
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('startup timeout')),5000);child.stdout.on('data',d=>{if(d.toString().includes('listening')){clearTimeout(t);resolve();}});child.on('error',reject);});
 const post=async(path,body,token)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return r.json();};
 const email='http@example.com';const auth=await post('/api/auth/start',{email});const session=await post('/api/auth/verify',{email,code:auth.devCode});await post('/api/consent',{consent:true},session.token);await post('/api/publish',{slug:'http-yard',html:'<!doctype html><html><head><title>Sam</title></head><body><!-- hb-public --><h1>Sam</h1></body></html>'},session.token);
 for(const concurrency of [1,25,100,400]){
  for(const path of ['/','/api/site/http-yard']){
   const samples=[];const statuses={};let failures=0;const start=performance.now();let next=0;const count=800;
   await Promise.all(Array.from({length:concurrency},async()=>{while(next++<count){const t=performance.now();try{const r=await fetch(base+path,{signal:AbortSignal.timeout(10000)});await r.arrayBuffer();statuses[r.status]=(statuses[r.status]||0)+1;}catch{failures++;}samples.push(performance.now()-t);}}));
   samples.sort((a,b)=>a-b);const elapsed=performance.now()-start;
   const row={path,concurrency,requests:count,statuses,failures,totalMs:Math.round(elapsed),requestsPerSecond:Math.round(count*1000/elapsed),p50Ms:Math.round(samples[Math.floor(samples.length*.5)]),p95Ms:Math.round(samples[Math.floor(samples.length*.95)]),p99Ms:Math.round(samples[Math.floor(samples.length*.99)])};results.push(row);console.log(JSON.stringify(row));
  }
 }
 // Malformed JSON must produce a 400 without damaging server health.
 const malformed=await fetch(base+'/api/draft',{method:'POST',body:'{"draft":'});await malformed.arrayBuffer();const health=await fetch(base+'/');await health.arrayBuffer();results.push({name:'malformed JSON recovery',malformedStatus:malformed.status,subsequentHomeStatus:health.status});
}catch(e){results.push({error:String(e),stderr:stderr.slice(0,500)});process.exitCode=1;}finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true});await writeFile(new URL('./http-results.json',import.meta.url),JSON.stringify({scope:'loopback Node dev server with temporary file store; warm reads; not production capacity; no real email or payment',results},null,2));}
