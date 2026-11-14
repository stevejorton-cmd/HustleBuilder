import puppeteer from 'puppeteer-core';
import {spawn} from 'node:child_process';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url).pathname,dir=await mkdtemp(tmpdir()+'/hb-browser-'),port=18978,base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['host/dev-server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HB_STORE_DIR:dir,PUBLISH_TEST_MODE:'1',PAYWALL_MODE:'test',PUBLIC_ORIGIN:base},stdio:['ignore','pipe','pipe']});
let browser;const results=[];
const post=async(path,body,token)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
try{
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('startup timeout')),10000);child.stdout.on('data',d=>{if(d.toString().includes('listening')){clearTimeout(t);resolve();}});child.once('error',reject);});
 browser=await puppeteer.launch({executablePath:process.env.CHROME||'/usr/local/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const email='parent@example.com',auth=await post('/api/auth/start',{email}),session=await post('/api/auth/verify',{email,code:auth.devCode});await post('/api/consent',{consent:true},session.token);
 const dismissIntro=async(p)=>{await p.evaluate(()=>{const el=document.getElementById("intro");const b=document.getElementById("introSkip");if(el&&!el.hidden&&b)b.click();const kid=document.getElementById("parentsKid");if(kid)kid.click();}).catch(()=>{});};
 const victim=await browser.newPage();await victim.goto(base);await dismissIntro(victim);
 const cookieLogin=await victim.evaluate(async email=>{const start=await (await fetch('/api/auth/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})})).json();return (await fetch('/api/auth/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,code:start.devCode})})).json();},email);
 session.token=cookieLogin.token;assert.ok((await victim.cookies()).some(c=>c.name==='hb_session'&&c.httpOnly));
 await victim.evaluate(token=>localStorage.setItem('hb-parent-session',JSON.stringify({token,email:'parent@example.com'})),session.token);
 const payload='<!doctype html><html><head><title>Isolation probe</title></head><body><!-- hb-public --><h1>Sam</h1><script>try{window.stolen=localStorage.getItem("hb-parent-session");window.blocked=false}catch(e){window.blocked=true;window.denial=e.name}</script></body></html>';
 await post('/api/publish',{slug:'isolated-yard',html:payload},session.token);
 const site=await browser.newPage();await site.goto(base+'/isolated-yard');
 const probe=await site.evaluate(()=>({blocked:window.blocked,denial:window.denial,stolen:window.stolen||null}));assert.equal(probe.blocked,true);assert.equal(probe.denial,'SecurityError');assert.equal(probe.stolen,null);results.push({name:'published script cannot read builder localStorage',pass:true,...probe});
 const apiBlocked=await site.evaluate(async base=>{try{await fetch(base+'/api/account',{credentials:'include'});return false;}catch{return true;}},base);assert.equal(apiBlocked,true);results.push({name:'published script cannot read parent account API with ambient cookies',pass:true});
 const booking=await site.evaluate(async base=>{const r=await fetch(base+'/api/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:'browser-probe-request',slug:'isolated-yard',name:'Neighbor',contact:'4025550199',service:'Mow',when:'Tomorrow',address:'123 Test Lane',t:5000})});return {status:r.status,body:await r.json()};},base);assert.equal(booking.status,200);assert.equal(booking.body.ok,true);results.push({name:'opaque-origin page successfully books through restricted CORS',pass:true});
 const ask=await post('/api/ask',{email:'other@example.com',first:'Sam',biz:'Sam’s Yard'});const parent=await browser.newPage();await parent.goto(base+'/?ask='+ask.token);await parent.waitForSelector('#askInviteNotice:not([hidden])');
 const state=await parent.evaluate(()=>({notice:document.querySelector('#askInviteNotice').textContent,hidden:document.querySelector('#pubBox').hidden}));assert.equal(state.hidden,true);assert.match(state.notice,/device where they built it/);results.push({name:'invitation on another device explains how to review the original draft',pass:true});
 // Each type is walked at phone width through every builder step. This is a functionality sweep, not a full design audit.
 const types=['lawn','snow','both','pet','odd','wash','help','tutor','other'];
 for(const type of types){
  const p=await browser.newPage();await p.setViewport({width:390,height:844});const errors=[];p.on('pageerror',e=>errors.push(String(e)));
  await p.goto(base);await dismissIntro(p);const selector='button.tile[data-type="'+type+'"]';assert.ok(await p.$(selector),'missing type: '+type);
  await p.select('#stepJump','0');await p.click(selector);for(let step=0;step<7;step++){await p.click('#next');}
  await p.waitForSelector('#pubEmail');assert.equal(errors.length,0,errors.join('\n'));const width=await p.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));assert.ok(width.scroll<=width.client+2,type+' overflow');results.push({name:'phone builder step sweep: '+type,pass:true});await p.close();
 }
 const offline=await browser.newPage();await offline.goto(base,{waitUntil:'networkidle0'});await dismissIntro(offline);
 await offline.evaluate(()=>navigator.serviceWorker.ready);
 await offline.select('#stepJump','1');await offline.type('input[data-k="first"]','OfflineSam');
 await offline.waitForFunction(()=>Object.keys(localStorage).some(k=>String(localStorage.getItem(k)).includes('OfflineSam')));
 await offline.waitForFunction(async()=>!!(await caches.match('/')));
 const cached=await offline.evaluate(async()=>{const urls=[];for(const name of await caches.keys())for(const request of await (await caches.open(name)).keys())urls.push(request.url);return urls;});
 assert.ok(cached.every(url=>!new URL(url).pathname.startsWith('/api/')));results.push({name:'service worker never caches private API responses',pass:true});
 await offline.setOfflineMode(true);await offline.reload({waitUntil:'domcontentloaded'});
 assert.match(await offline.$eval('input[data-k="first"]',el=>el.value),/OfflineSam/);results.push({name:'v4 builder reopens saved progress offline',pass:true});
 await offline.setOfflineMode(false);await offline.close();
 console.log(JSON.stringify(results,null,2));
}finally{if(browser)await browser.close();child.kill('SIGTERM');await rm(dir,{recursive:true,force:true});await writeFile(new URL('../stress/browser-security-results.json',import.meta.url),JSON.stringify(results,null,2));}
