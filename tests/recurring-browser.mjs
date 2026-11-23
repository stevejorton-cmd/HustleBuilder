// Real browser coverage for repeating visits and limited family access.
// All accounts, payments, mail, and bookings use an isolated local test store.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {extractBuilderParts,demoCfg} from './site-fixture.mjs';

const root=new URL('../',import.meta.url).pathname;
const dir=await mkdtemp(tmpdir()+'/hb-recurring-browser-');
const port=18983,base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['host/dev-server.mjs'],{
  cwd:root,
  env:{...process.env,PORT:String(port),HB_STORE_DIR:dir,DATABASE_URL:'',BLOB_READ_WRITE_TOKEN:'',RESEND_API_KEY:'',
    PUBLISH_TEST_MODE:'1',PAYWALL_MODE:'test',PUBLIC_ORIGIN:base},
  stdio:['ignore','pipe','pipe']
});
const results=[],errors=[];
let browser,serverOutput='';
child.stdout.on('data',chunk=>{serverOutput+=String(chunk);});
child.stderr.on('data',chunk=>{serverOutput+=String(chunk);});
const pass=name=>{results.push(name);console.log('PASS recurring browser: '+name);};

async function api(path,{body,token}={}){
  const response=await fetch(base+path,{
    method:body?'POST':'GET',
    headers:{'content-type':'application/json',origin:base,...(token?{authorization:'Bearer '+token}:{})},
    body:body?JSON.stringify(body):undefined
  });
  const data=await response.json();
  assert.equal(response.status,200,path+': '+JSON.stringify(data));
  assert.equal(data.ok,true,path+': '+JSON.stringify(data));
  return data;
}
async function click(page,selector){
  await page.waitForSelector(selector,{visible:true});
  await page.$eval(selector,el=>el.scrollIntoView({block:'center',behavior:'instant'}));
  await page.waitForFunction(selector=>{
    const el=document.querySelector(selector),rect=el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2));
  },{},selector);
  await page.click(selector);
}
async function fill(page,selector,value){
  await page.$eval(selector,el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.type(selector,value);
}
async function preparePage(context,path){
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(String(error)));
  await page.setViewport({width:390,height:844});
  await page.goto(base+path,{waitUntil:'networkidle0'});
  await page.evaluate(()=>{document.getElementById('introSkip')?.click();document.getElementById('parentsKid')?.click();});
  return page;
}
async function login(page,email){
  await click(page,'#mBuild');
  await page.select('#stepJump','7');
  await fill(page,'#pubEmail',email);
  await page.$eval('#parentHere',el=>el.open=true);
  await page.$eval('#parentOwner',el=>{el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));});
  await click(page,'#pubSend');
  await page.waitForFunction(()=>/code is \d{6}/.test(document.getElementById('pubCodeMsg').textContent));
  // This code is generated only by PUBLISH_TEST_MODE on the local server.
  const code=(await page.$eval('#pubCodeMsg',el=>el.textContent)).match(/\d{6}/)[0];
  await fill(page,'#pubCode',code);await click(page,'#pubVerify');
  await page.waitForFunction(()=>!document.getElementById('pubVerified').hidden);
}
async function waitCardStatus(page,action,status){
  await page.waitForFunction((action,status)=>{
    const button=document.querySelector('[data-job="'+action+'"][data-st="cancel-series"]');
    return button?.closest('.kidjob').querySelector('.jobst')?.textContent.trim()===status;
  },{},action,status);
}

try{
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Local server timed out: '+serverOutput)),10000);
    child.stdout.on('data',chunk=>{if(String(chunk).includes('listening')){clearTimeout(timeout);resolve();}});
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('exit',code=>{clearTimeout(timeout);reject(Error('Local server exited '+code+': '+serverOutput));});
  });
  browser=await puppeteer.launch({executablePath:process.env.CHROME||'/usr/local/bin/google-chrome',headless:true,
    protocolTimeout:120000,args:['--no-sandbox','--disable-dev-shm-usage']});
  const email='recurring-browser-parent@example.com';
  const auth=await api('/api/auth/start',{body:{email}});
  const verified=await api('/api/auth/verify',{body:{email,code:auth.devCode}});
  const token=verified.token;
  await api('/api/consent',{body:{consent:true},token});
  const plan=await api('/api/checkout',{body:{plan:'year'},token});
  assert.equal(plan.url,undefined,'test checkout must not leave the isolated server');
  const {genSite}=extractBuilderParts(await readFile(root+'/index.html','utf8'));
  const weeklySlug='recurring-alex',siblingSlug='recurring-riley';
  const published=await api('/api/publish',{token,body:{slug:weeklySlug,tz:'America/Chicago',html:genSite(demoCfg({
    first:'Alex',biz:'Alex Yard Crew',services:[{n:'Leaf cleanup',p:'$20'}],
    publish:{slug:weeklySlug,book:base+'/api/book'}
  }))}});
  await api('/api/publish',{token,body:{slug:siblingSlug,tz:'America/Chicago',html:genSite(demoCfg({
    type:'pet',first:'Riley',biz:'Riley Pet Crew',services:[{n:'Dog walk',p:'$15'}],
    publish:{slug:siblingSlug,book:base+'/api/book'}
  }))}});
  const day=new Date(Date.now()+8*864e5).toISOString().slice(0,10),start=day+'T16:00';
  await api('/api/book',{body:{requestId:'repeat-browser-weekly-001',slug:weeklySlug,name:'Practice Neighbor',
    contact:'recurring-browser-customer@example.com',service:'Leaf cleanup',freq:'Every week',start,
    when:day+' at 4 PM',address:'TEST ONLY - no real visit',note:'TEST ONLY: no real work or payment.',t:5000}});
  await api('/api/book',{body:{requestId:'repeat-browser-sibling-001',slug:siblingSlug,name:'Practice Sibling Neighbor',
    contact:'recurring-browser-sibling@example.com',service:'Dog walk',start:day+'T17:00',when:day+' at 5 PM',
    address:'TEST ONLY - no real visit',note:'TEST ONLY: no real work or payment.',t:5000}});
  const initial=await api('/api/my-jobs',{token});
  assert.equal(initial.jobs.length,2);
  const original=initial.jobs.find(job=>job.businessKey===weeklySlug);
  const sibling=initial.jobs.find(job=>job.businessKey===siblingSlug);
  assert.equal(original.series,null,'a frequency preference must remain one unapproved appointment');

  const parent=await preparePage(browser.defaultBrowserContext(),'/?build=1');
  await login(parent,email);await click(parent,'#mBoss');
  await parent.waitForSelector('#jobFilters:not([hidden])');await parent.select('#jobKidFilter',weeklySlug);
  assert.equal((await parent.$$('#jobList .kidjob')).length,1);
  await parent.select('#jobList select[data-series-count]','3');
  await click(parent,'[data-job="'+original.action+'"][data-st="approve-series"]');
  assert.match(await parent.$eval('#mbody',el=>el.textContent),/original booking plus 2 more visits/);
  await click(parent,'#cfYes');
  await parent.waitForFunction(()=>/Approved 3 visits/.test(document.getElementById('jobStatus').textContent)
    && document.querySelectorAll('#jobList .kidjob').length===3);
  const approved=await api('/api/my-jobs',{token});
  const visits=approved.jobs.filter(job=>job.businessKey===weeklySlug).sort((a,b)=>a.series.index-b.series.index);
  assert.equal(visits.length,3);assert.equal(new Set(visits.map(job=>job.id)).size,3);
  assert.equal(new Set(visits.map(job=>job.action)).size,3);
  assert.deepEqual(visits.map(job=>[job.series.index,job.series.total,job.status]),[[1,3,'confirmed'],[2,3,'confirmed'],[3,3,'confirmed']]);
  const seriesText=await parent.$eval('#jobList',el=>el.textContent);
  for(let n=1;n<=3;n++)assert.ok(seriesText.includes('Visit '+n+' of 3'));
  pass('parent approves three weekly visits through the phone-sized UI, creating distinct confirmed cards and actions');

  const kidContext=await browser.createBrowserContext();
  const kid=await preparePage(kidContext,'/?jobs=1');
  await click(kid,'#mBoss');await click(kid,'#kidJobsEntry summary');
  await fill(kid,'#kidJobsCodeInput',published.jobCode);await click(kid,'#openKidJobs');
  await kid.waitForSelector('#jobList button[data-ask-cancel]');
  assert.equal((await kid.$$('#jobList .kidjob')).length,4);
  assert.equal(await kid.$('#jobList button[data-job],#jobList select[data-series-count]'),null);
  assert.match(await kid.$eval('#jobList',el=>el.textContent),/Visit 3 of 3/);
  const kidData=await kid.evaluate(async code=>(await fetch('/api/my-jobs?code='+encodeURIComponent(code))).json(),published.jobCode);
  assert.equal(kidData.parentAuthenticated,false);assert.ok(kidData.jobs.every(job=>!job.action));
  pass('a separate kid session sees repeating visits and can ask a parent, with no approval or cancellation controls');

  await click(parent,'[data-job="'+visits[1].action+'"][data-st="cancelled"]');await click(parent,'#cfYes');
  await waitCardStatus(parent,visits[1].action,'Cancelled');
  const afterOne=await api('/api/my-jobs',{token});
  assert.deepEqual(visits.map(visit=>afterOne.jobs.find(job=>job.id===visit.id).status),['confirmed','cancelled','confirmed']);
  assert.deepEqual(afterOne.jobs.find(job=>job.id===sibling.id),sibling);
  pass('cancelling the second visit leaves the other two visits and the sibling booking unchanged');

  await click(parent,'[data-job="'+visits[0].action+'"][data-st="cancel-series"]');
  assert.match(await parent.$eval('#mbody',el=>el.textContent),/Only future, uncompleted visits/);
  await click(parent,'#cfYes');
  await parent.waitForFunction(()=>/Cancelled 2 future visits/.test(document.getElementById('jobStatus').textContent)
    && [...document.querySelectorAll('#jobList .jobst')].every(el=>el.textContent.trim()==='Cancelled'));
  const cancelled=await api('/api/my-jobs',{token});
  assert.ok(visits.every(visit=>cancelled.jobs.find(job=>job.id===visit.id).status==='cancelled'));
  assert.deepEqual(cancelled.jobs.find(job=>job.id===sibling.id),sibling);
  await parent.select('#jobKidFilter',siblingSlug);
  assert.equal((await parent.$$('#jobList .kidjob')).length,1);
  assert.match(await parent.$eval('#jobList',el=>el.textContent),/Riley.*Dog walk/s);
  assert.equal(await parent.$eval('#jobList .jobst',el=>el.textContent.trim()),'New');
  pass('cancel remaining visits removes only the other future series visits, preserving the sibling request and filter');

  const secondKidTab=await preparePage(kidContext,'/?jobs=1');await click(secondKidTab,'#mBoss');
  await secondKidTab.waitForSelector('#jobList .kidjob');
  const draftBefore=await secondKidTab.evaluate(()=>localStorage.getItem('hustle-builder-v3'));
  await click(kid,'#forgetKidJobs');
  await secondKidTab.waitForFunction(()=>document.getElementById('jobList').innerHTML===''
    && /forgotten in another tab/.test(document.getElementById('kidJobsStatus').textContent),{timeout:5000});
  assert.equal(await secondKidTab.evaluate(()=>localStorage.getItem('hb-kid-jobs-code')),null);
  assert.equal(await secondKidTab.$('#sharedSessionLock'),null);
  assert.equal(await secondKidTab.evaluate(()=>localStorage.getItem('hustle-builder-v3')),draftBefore);
  assert.equal(await secondKidTab.$eval('#forgetKidJobs',el=>el.hidden),true);
  pass('forgetting a kid code clears another real tab immediately, without locking or replacing its draft');

  assert.deepEqual(errors,[]);pass('no uncaught application errors during recurring and shared-device browser checks');
  console.log(JSON.stringify({passed:results.length,results},null,2));
}finally{
  if(browser)await browser.close();
  child.kill('SIGTERM');
  await rm(dir,{recursive:true,force:true});
}
