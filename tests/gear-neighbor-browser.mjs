// End-to-end coverage for the parent gear reward and private neighbor agreement.
// All identities, messages, jobs and payments live in this isolated test store.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {extractBuilderParts,demoCfg} from './site-fixture.mjs';
import {gearFilename,gearExportSize} from '../assets/gear-studio.mjs';

const root=new URL('../',import.meta.url).pathname;
const dir=await mkdtemp(tmpdir()+'/hb-gear-neighbor-');
const downloads=dir+'/downloads';await mkdir(downloads);
const port=18984,base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['host/dev-server.mjs'],{cwd:root,
  env:{...process.env,PORT:String(port),HB_STORE_DIR:dir+'/store',DATABASE_URL:'',BLOB_READ_WRITE_TOKEN:'',RESEND_API_KEY:'',PUBLISH_TEST_MODE:'1',PAYWALL_MODE:'test',PUBLIC_ORIGIN:base},
  stdio:['ignore','pipe','pipe']});
let browser,serverOutput='';const results=[],errors=[];
child.stdout.on('data',chunk=>{serverOutput+=String(chunk);});child.stderr.on('data',chunk=>{serverOutput+=String(chunk);});
const pass=name=>{results.push(name);console.log('PASS gear & neighbor browser: '+name);};
async function api(path,{body,token}={}){
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',origin:base,...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  const data=await response.json();assert.equal(response.status,200,path+': '+JSON.stringify(data));assert.equal(data.ok,true,path+': '+JSON.stringify(data));return data;
}
async function sessionApi(page,path,body){
  const response=await page.evaluate(async({path,body})=>{const r=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};},{path,body});
  assert.equal(response.status,200,path+': '+JSON.stringify(response.data));assert.equal(response.data.ok,true);return response.data;
}
async function click(page,selector){
  await page.bringToFront();await page.waitForSelector(selector,{visible:true});
  await page.waitForFunction(selector=>{const el=document.querySelector(selector);if(!el)return false;el.scrollIntoView({block:'center',behavior:'instant'});const r=el.getBoundingClientRect();return !el.disabled&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},{},selector);
  await page.click(selector);
}
async function fill(page,selector,value){
  await page.bringToFront();await page.$eval(selector,el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.type(selector,value);
}
async function submit(page,selector){await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),click(page,selector)]);}
async function pageFor(context,path){const page=await context.newPage();page.on('pageerror',error=>errors.push(String(error)));await page.setViewport({width:390,height:844});await page.goto(base+path,{waitUntil:'networkidle0'});return page;}
async function login(page,email){
  await page.$eval('#parentHere',el=>el.open=true);await fill(page,'#pubEmail',email);
  await page.$eval('#parentOwner',el=>{el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));});await click(page,'#pubSend');
  await page.waitForFunction(()=>/code is \d{6}/.test(document.getElementById('pubCodeMsg').textContent));
  const code=(await page.$eval('#pubCodeMsg',el=>el.textContent)).match(/\d{6}/)[0];
  await fill(page,'#pubCode',code);await click(page,'#pubVerify');await page.waitForFunction(()=>!document.getElementById('pubVerified').hidden);
}
async function downloaded(filename){
  const until=Date.now()+15000;
  while(Date.now()<until){if((await readdir(downloads)).includes(filename))return readFile(downloads+'/'+filename);await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('Download did not complete: '+filename+'; found '+(await readdir(downloads)).join(', '));
}
async function sendBooking(slug,n){
  const day=new Date(Date.now()+(8+n)*864e5).toISOString().slice(0,10);
  return api('/api/book',{body:{requestId:'gear-browser-request-'+n,slug,name:'Practice Neighbor',contact:'gear-neighbor-customer@example.com',service:'Leaf cleanup',price:'10',start:day+'T16:00',when:day+' at 4 PM',address:'TEST ONLY - no real visit',note:'Isolated test. No work or payment.',t:5000}});
}
const quoteForm='form:has(input[name="action"][value="send-quote"])';
const questionForm='form:has(input[name="action"][value="question"])';
const replyForm='form:has(input[name="action"][value="reply"])';
const acceptForm='form:has(input[name="action"][value="accept-quote"])';

try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Local server timed out: '+serverOutput)),10000);child.stdout.on('data',chunk=>{if(String(chunk).includes('listening')){clearTimeout(timeout);resolve();}});child.once('error',reject);child.once('exit',code=>reject(Error('Server exited '+code+': '+serverOutput)));});
  browser=await puppeteer.launch({executablePath:process.env.CHROME||'/usr/local/bin/google-chrome',headless:true,protocolTimeout:120000,args:['--no-sandbox','--disable-dev-shm-usage']});
  const downloadSession=await browser.target().createCDPSession();await downloadSession.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  const email='gear-neighbor-parent@example.com',auth=await api('/api/auth/start',{body:{email}});
  const signed=await api('/api/auth/verify',{body:{email,code:auth.devCode}}),token=signed.token;
  await api('/api/consent',{token,body:{consent:true}});await api('/api/checkout',{token,body:{plan:'year'}});
  const {genSite}=extractBuilderParts(await readFile(root+'/index.html','utf8'));
  const specs=[{slug:'gear-riley',first:'Riley',biz:'Riley Yard Crew',font:'anton',theme:'hustle',palette:'mower'},{slug:'gear-quinn',first:'Quinn',biz:'Quinn Pet Club',font:'fredoka',theme:'neighbor',palette:'forest',type:'pet'}];
  let jobCode='';
  for(const spec of specs){
    const draft=await api('/api/draft',{token,body:{draft:{first:spec.first,bizName:spec.biz,siteFont:spec.font,theme:spec.theme,palette:spec.palette,type:spec.type||'lawn',tagline:'Neighbors can count on us',siteUrl:base+'/'+spec.slug}}});
    const published=await api('/api/publish',{token,body:{slug:spec.slug,draftCode:draft.code,tz:'America/Chicago',html:genSite(demoCfg({...spec,publish:{slug:spec.slug,book:base+'/api/book'}}))}});jobCode=published.jobCode||jobCode;
  }
  const saved=await api('/api/gear',{token}),riley=saved.businesses.find(b=>b.slug==='gear-riley'),quinn=saved.businesses.find(b=>b.slug==='gear-quinn');
  assert.equal(riley.brand.font,'anton');assert.equal(quinn.brand.font,'fredoka');
  const parent=await pageFor(browser.defaultBrowserContext(),'/?gear=1&business='+riley.id);
  assert.equal(await parent.$('dialog.hbgear'),null);await login(parent,email);
  await parent.waitForSelector('dialog.hbgear[open]');await parent.waitForSelector('[data-gear-download="shirt-svg"]:not([disabled])');
  assert.equal(await parent.$eval('.hbgear-business',el=>el.textContent),'Riley Yard Crew');
  assert.equal(await parent.$eval('[data-gear-email-opt-in]',el=>el.checked),false);
  assert.equal(await parent.$('[data-gear-download="badge-png"]'),null);
  pass('parent email link waits for sign-in, then opens the correct saved child despite the newest sibling draft');

  await click(parent,'[data-gear-style="work-crew"]');await click(parent,'[data-gear-color="forest"]');await click(parent,'[data-gear-placement="back"]');
  for(const selector of ['[data-gear-style="work-crew"]','[data-gear-color="forest"]','[data-gear-placement="back"]'])assert.equal(await parent.$eval(selector,el=>el.getAttribute('aria-pressed')),'true');
  for(const width of [390,320]){await parent.setViewport({width,height:844});assert.ok(await parent.$eval('dialog.hbgear',el=>el.scrollWidth<=el.clientWidth+2),'gear must fit '+width+'px');}
  await parent.setViewport({width:390,height:844});
  const artOptions={style:'work-crew',color:'forest',placement:'back'},brand={businessName:riley.business};
  await click(parent,'[data-gear-download="shirt-svg"]');
  const svg=(await downloaded(gearFilename(brand,{...artOptions,garment:'shirt'},'svg'))).toString();
  assert.match(svg,/Riley Yard Crew/);assert.match(svg,/HB-anton/);assert.match(svg,/data:font\/woff2;base64,/);assert.doesNotMatch(svg,/Quinn Pet Club|gear-neighbor-parent|api\/job|api\/booking/);
  await click(parent,'[data-gear-download="hoodie-png"]');
  const png=await downloaded(gearFilename(brand,{...artOptions,garment:'hoodie'},'png')),size=gearExportSize('hoodie');
  assert.equal(png.readUInt32BE(16),size.width);assert.equal(png.readUInt32BE(20),size.height);
  const raster=await parent.evaluate(async encoded=>{const img=new Image();await new Promise((yes,no)=>{img.onload=yes;img.onerror=no;img.src='data:image/png;base64,'+encoded;});const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let ink=false;for(let i=3;i<pixels.length;i+=388){if(pixels[i]){ink=true;break;}}return {corner:pixels[3],ink};},png.toString('base64'));
  assert.equal(raster.corner,0);assert.equal(raster.ink,true);
  pass('phone gear controls work and real downloads preserve the selected font, correct business, high resolution and transparency');

  await click(parent,'[data-gear-email-opt-in]');await parent.waitForFunction(()=>document.querySelector('.hbgear-preference-status')?.textContent.includes('on for this business'));
  let gear=await sessionApi(parent,'/api/gear');assert.equal(gear.businesses.find(b=>b.id===riley.id).milestoneEmails,true);assert.equal(gear.businesses.find(b=>b.id===quinn.id).milestoneEmails,false);
  await click(parent,'.hbgear-close');await click(parent,'[data-gear-slug="gear-quinn"]');
  await parent.waitForSelector('dialog.hbgear[open]');assert.equal(await parent.$eval('.hbgear-business',el=>el.textContent),'Quinn Pet Club');assert.equal(await parent.$eval('[data-gear-email-opt-in]',el=>el.checked),false);await click(parent,'.hbgear-close');
  pass('parent milestone email preference is saved only for the selected child and account gear switches siblings correctly');

  const firstBooking=await sendBooking('gear-riley',1);assert.ok(firstBooking.manageUrl,'booking immediately returns its private management link');
  let jobs=await sessionApi(parent,'/api/my-jobs'),job=jobs.jobs.find(j=>j.businessKey==='gear-riley');
  const parentDetail=await pageFor(browser.defaultBrowserContext(),new URL(job.detailsUrl).pathname);
  await click(parent,'#mBoss');await parent.waitForSelector('#jobList a[href$="'+job.action+'"]');
  await click(parentDetail,'section[aria-labelledby="quote-heading"] details summary');
  await fill(parentDetail,quoteForm+' [name="scope"]','Rake the front yard and bag the leaves.');await fill(parentDetail,quoteForm+' [name="equipment"]','Riley brings a rake. Neighbor supplies three bags.');
  await fill(parentDetail,quoteForm+' [name="exclusions"]','No ladders or roof work.');await fill(parentDetail,quoteForm+' [name="itemDescription0"]','Front yard leaf cleanup');await fill(parentDetail,quoteForm+' [name="itemAmount0"]','25');
  await submit(parentDetail,quoteForm+' button[type="submit"]');assert.match(await parentDetail.$eval('body',el=>el.textContent),/\$25\.00/);
  await click(parent,'#refreshJobs');await parent.waitForSelector('[data-st="done"][disabled]');
  const customerContext=await browser.createBrowserContext(),customer=await pageFor(customerContext,new URL(firstBooking.manageUrl).pathname);
  assert.match(await customer.$eval('body',el=>el.textContent),/Riley brings a rake.*supplies three bags/s);
  await click(customer,acceptForm+' [name="accept"]');await submit(customer,acceptForm+' button[type="submit"]');
  await click(parent,'#refreshJobs');await parent.waitForSelector('[data-st="done"]:not([disabled])');
  pass('parent sends a complete quote and the neighbor explicitly accepts it before job controls become available');

  await fill(customer,questionForm+' [name="text"]','Can I leave the bags by the porch?');await submit(customer,questionForm+' button[type="submit"]');
  await parentDetail.reload({waitUntil:'networkidle0'});assert.match(await parentDetail.$eval('body',el=>el.textContent),/leave the bags by the porch/);
  await fill(parentDetail,replyForm+' [name="text"]','Yes, the porch is a good place.');await submit(parentDetail,replyForm+' button[type="submit"]');
  await customer.reload({waitUntil:'networkidle0'});assert.match(await customer.$eval('body',el=>el.textContent),/porch is a good place/);
  assert.match(await customer.$eval('body',el=>el.textContent),/Quote accepted|Accepted|accepted/);
  pass('customer and parent exchange private follow-up messages while preserving the accepted price');

  for(let n=1;n<=3;n++){
    if(n>1)await sendBooking('gear-riley',n);
    jobs=await sessionApi(parent,'/api/my-jobs');job=jobs.jobs.filter(j=>j.businessKey==='gear-riley'&&j.status!=='done'&&!j.inquiry).at(-1);
    await api('/api/job/'+job.action,{body:{status:'done',json:true}});
  }
  gear=await sessionApi(parent,'/api/gear');assert.equal(gear.businesses.find(b=>b.id===riley.id).completedJobs,3);assert.equal(gear.businesses.find(b=>b.id===quinn.id).completedJobs,0);
  const mail=await api('/api/test/outbox?email='+encodeURIComponent(email));
  assert.equal(mail.messages.filter(m=>/earned Operator/.test(m.subject)).length,1);
  await api('/api/job/'+job.action,{body:{status:'done',json:true}});
  const afterReplay=await api('/api/test/outbox?email='+encodeURIComponent(email));assert.equal(afterReplay.messages.filter(m=>/earned Operator/.test(m.subject)).length,1);
  await click(parent,'#myBusinessGear');await parent.waitForSelector('[data-gear-business="'+riley.id+'"]');await click(parent,'[data-gear-business="'+riley.id+'"]');await parent.waitForSelector('[data-gear-download="badge-svg"]:not([disabled])');
  assert.match(await parent.$eval('.hbgear-milestone',el=>el.textContent),/Operator unlocked/);
  assert.match(await parent.$eval('.hbgear-coming-soon',el=>el.textContent),/Coming Soon/);
  assert.equal(await parent.$('dialog.hbgear a[href],.hbgear-preview-cap,[data-gear-download^="cap-"]'),null);
  pass('three parent-Done jobs unlock free Operator artwork and queue one opted-in parent email, with sibling progress unchanged');

  const inquiry=await pageFor(customerContext,'/gear-quinn');await submit(inquiry,'a[href="/api/inquiry/gear-quinn"]');
  await fill(inquiry,'[name="name"]','Practice Neighbor');await fill(inquiry,'[name="email"]','gear-inquiry@example.com');await fill(inquiry,'[name="text"]','Do you bring your own pet toys?');
  const before=await sessionApi(parent,'/api/my-jobs');
  await inquiry.waitForFunction(()=>Date.now()-Number(document.querySelector('[name="startedAt"]').value)>=2500);
  await submit(inquiry,'form button[type="submit"]');assert.match(new URL(inquiry.url()).pathname,/^\/api\/booking\//);
  await fill(inquiry,questionForm+' [name="text"]','We have a ball ready if that helps.');await submit(inquiry,questionForm+' button[type="submit"]');
  assert.match(await inquiry.$eval('body',el=>el.textContent),/ball ready/);
  const after=await sessionApi(parent,'/api/my-jobs');assert.equal(after.jobs.filter(j=>!j.inquiry).length,before.jobs.filter(j=>!j.inquiry).length);assert.equal(after.jobs.filter(j=>j.inquiry).length,1);
  await click(parent,'.hbgear-close');await click(parent,'#refreshJobs');await parent.waitForSelector('#jobList [data-inquiry="true"]');assert.equal(await parent.$('#jobList [data-inquiry="true"] button[data-job]'),null);
  const kid=await pageFor(await browser.createBrowserContext(),'/?jobs=1');
  const kidData=await api('/api/my-jobs?code='+encodeURIComponent(jobCode));assert.ok(kidData.jobs.every(j=>!j.inquiry&&!j.action&&!j.detailsUrl));assert.equal(kidData.jobs.length,3);
  pass('a public question and immediate follow-up stay private and create no booking; kid access does not expose inquiries or parent controls');

  await click(kid,'#mFlyers');await click(kid,'#previewBusinessGear');await kid.waitForSelector('dialog.hbgear[open]');
  assert.ok(await kid.$('.hbgear-preview-hoodie'));
  assert.match(await kid.$eval('.hbgear-coming-soon',el=>el.textContent),/Coming Soon/);
  assert.equal(await kid.$('dialog.hbgear a[href],.hbgear-preview-cap'),null);
  assert.ok(await kid.$('.hbgear-draft-note'));assert.equal(await kid.$('.hbgear-handoff,[data-gear-email-opt-in],.hbgear-milestone'),null);await click(kid,'.hbgear-close');
  assert.equal(await kid.$eval('#previewBusinessGear',el=>document.activeElement===el),true);
  pass('draft preview offers free downloads, restores focus, and keeps parent shopping and email settings out of the child view');

  await click(parent,'#myBusinessGear');await click(parent,'[data-gear-business="'+riley.id+'"]');await parent.waitForSelector('dialog.hbgear[open]');
  const otherParent=await pageFor(browser.defaultBrowserContext(),'/?account=1');await otherParent.waitForSelector('#acctSignOut:not([hidden])');await click(otherParent,'#acctSignOut');
  await parent.waitForFunction(()=>!document.querySelector('dialog.hbgear'),{polling:100,timeout:5000});
  assert.equal(await parent.$eval('#myBusinessGear',el=>el.hidden),true);
  pass('signing out in another tab immediately removes open private gear and its parent entry point');
  assert.deepEqual(errors,[]);pass('no uncaught application errors across the gear, quote and question flows');
  console.log(JSON.stringify({passed:results.length,results},null,2));
}finally{if(browser)await browser.close();child.kill('SIGTERM');await rm(dir,{recursive:true,force:true});}
