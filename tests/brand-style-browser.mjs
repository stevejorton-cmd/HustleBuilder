import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const dir=await mkdtemp(path.join(tmpdir(),'hb-brand-'));
const port=Number(process.env.BRAND_PORT||8805),base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['host/dev-server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HB_STORE_DIR:dir,PUBLISH_TEST_MODE:'1',PAYWALL_MODE:'test',ADMIN_SECRET:'local-brand-tests'},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',d=>process.stderr.write(d));
let browser,checks=0;
const pass=name=>{checks++;console.log('PASS '+name);};
const types=['pet','prep','lawn','snow','both','odd','wash','help','tutor','other'];
const schemes={hustle:{bg:'rgb(32, 38, 44)',accent:'rgb(217, 75, 61)'},neighbor:{bg:'rgb(251, 248, 242)',accent:'rgb(36, 91, 69)'}};

async function click(p,selector){
  await p.waitForSelector(selector,{visible:true});
  await p.$eval(selector,el=>el.scrollIntoView({block:'center',behavior:'instant'}));
  await p.waitForFunction(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},{},selector);
  await p.click(selector);
}
async function openBuilder(p){
  await p.goto(base+'/?build=1',{waitUntil:'networkidle0'});
  if(await p.$eval('#intro',el=>!el.hidden))await click(p,'#introSkip');
  await p.waitForSelector('#themes button[data-brand-style="hustle"]',{visible:true});
}
async function preview(p,theme){
  const expected=await p.$eval('#bizName',el=>el.value||el.placeholder);
  await p.waitForFunction(({theme,expected})=>{
    const html=document.getElementById('frame').srcdoc;
    const title=(html.match(/<h1[^>]*>(.*?)<\/h1>/s)||[])[1];
    return html.includes('data-theme="'+theme+'"')&&title===expected;
  },{}, {theme,expected});
  const f=await (await p.$('#frame')).contentFrame();
  await f.waitForFunction(()=>{const img=document.querySelector('.hero img');return img&&img.complete&&img.naturalWidth>0;});
  return f;
}

try{
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('server timeout')),10000);child.stdout.on('data',d=>{if(String(d).includes('listening')){clearTimeout(t);resolve();}});child.once('error',reject);});
  browser=await puppeteer.launch({executablePath:process.env.CHROME||'/usr/local/bin/google-chrome',headless:true,protocolTimeout:120000,args:['--no-sandbox','--disable-dev-shm-usage']});
  const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(String(e)));
  await p.setViewport({width:1366,height:900});await openBuilder(p);
  assert.equal(await p.$eval('#plabel',el=>el.textContent),'Step 1 of 8');
  assert.deepEqual(await p.$$eval('#themes .tn',els=>els.map(el=>el.textContent)),['Energy','Neighbor']);
  for(const width of [1366,390,320]){
    await p.setViewport({width,height:900});
    for(const theme of ['hustle','neighbor']){
      await click(p,'#themes [data-brand-style="'+theme+'"]');
      for(const type of types){
        await click(p,'.tile[data-type="'+type+'"]');
        const f=await preview(p,theme);
        const shell=await p.evaluate(()=>{
          const root=getComputedStyle(document.documentElement),b=document.querySelector('#themes button[aria-pressed="true"]');
          return {theme:document.documentElement.dataset.businessStyle,bg:getComputedStyle(document.body).backgroundColor,accent:getComputedStyle(document.getElementById('next')).backgroundColor,selected:b.dataset.brandStyle,stored:JSON.parse(localStorage.getItem('hustle-builder-v3')),overflow:document.documentElement.scrollWidth-innerWidth};
        });
        const site=await f.evaluate(()=>({theme:document.documentElement.dataset.theme,bg:getComputedStyle(document.body).backgroundColor,accent:getComputedStyle(document.getElementById('heroCta')).backgroundColor,pet:document.querySelector('.petbar')?getComputedStyle(document.querySelector('.petbar')).backgroundColor:null,booking:!!document.querySelector('#cal')&&!!document.querySelector('#svc')}));
        assert.equal(shell.theme,theme);assert.equal(shell.selected,theme);assert.equal(shell.stored.theme,theme);assert.equal(shell.stored.type,type);
        assert.equal(shell.bg,schemes[theme].bg);assert.equal(shell.accent,schemes[theme].accent);assert.ok(shell.overflow<=2,'builder overflow '+JSON.stringify({theme,type,width,overflow:shell.overflow}));
        assert.equal(site.theme,theme);assert.equal(site.bg,schemes[theme].bg);assert.equal(site.accent,schemes[theme].accent);assert.ok(site.booking);
        if(type==='pet')assert.equal(site.pet,schemes[theme].bg);
        await p.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
        const picker=await p.$eval('#themes',el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,header:document.querySelector('header.top').getBoundingClientRect().bottom};});
        assert.ok(picker.top>=picker.header-1&&picker.bottom<900,'style buttons visible at the start of Step 1');
        pass('visible style, builder and preview: '+theme+' '+type+' '+width);
      }
    }
  }
  // A reload keeps the chosen style and the real draft, rather than just the button label.
  await p.reload({waitUntil:'networkidle0'});await preview(p,'neighbor');
  assert.equal(await p.$eval('body',el=>getComputedStyle(el).backgroundColor),schemes.neighbor.bg);
  pass('Neighbor selection and colors survive reload');
  await p.select('#stepJump','5');await click(p,'[data-step="5"] details.help > summary');
  await click(p,'#rigs button:nth-child(9)');
  assert.equal(await p.$eval('#next',el=>getComputedStyle(el).backgroundColor),'rgb(20, 184, 166)');
  await click(p,'#themes [data-brand-style="hustle"]');
  await p.select('#stepJump','0');await click(p,'.tile[data-type="pet"]');await preview(p,'hustle');
  assert.equal(await p.$eval('#next',el=>getComputedStyle(el).backgroundColor),schemes.hustle.accent);
  pass('choosing Energy restores mower red after a custom color');
  if(process.env.SHOTS){await mkdir(process.env.SHOTS,{recursive:true});await p.setViewport({width:1366,height:900});await p.evaluate(()=>scrollTo(0,0));await p.screenshot({path:path.join(process.env.SHOTS,'energy-pet-builder.png')});}
  // Reproduce the reported persisted combination: old orange app preferences,
  // an empty page-theme id and a teal pet palette. Preserve content and records.
  const context=await browser.createBrowserContext(),legacy=await context.newPage();
  await legacy.evaluateOnNewDocument(()=>{
    if(!localStorage.getItem('brand-test-seeded')){
      localStorage.setItem('brand-test-seeded','1');
      localStorage.setItem('hb-anonymous-draft','1');
      localStorage.setItem('hustle-look-v1',JSON.stringify({mode:'auto',accent:'#FF5B14'}));
      localStorage.setItem('hustle-builder-v3',JSON.stringify({theme:'',type:'pet',palette:'teal',look:'day',first:'Alex',town:'Lincoln',svcEdited:true,services:[{n:'Dog walk',p:'19'}],reviews:[{n:'Casey',q:'On time'}]}));
      localStorage.setItem('hustle-boss-v1',JSON.stringify({jobs:[{id:'kept-job',customer:'Casey',amount:19}],costs:[],upcoming:[]}));
    }
  });
  await legacy.setViewport({width:1366,height:900});await openBuilder(legacy);await preview(legacy,'hustle');
  assert.equal(await legacy.$eval('#next',el=>getComputedStyle(el).backgroundColor),schemes.hustle.accent);
  assert.equal(await legacy.$eval('body',el=>getComputedStyle(el).backgroundColor),schemes.hustle.bg);
  await click(legacy,'#themes [data-brand-style="hustle"]');
  await legacy.reload({waitUntil:'networkidle0'});await preview(legacy,'hustle');
  const kept=await legacy.evaluate(()=>({draft:JSON.parse(localStorage.getItem('hustle-builder-v3')),boss:JSON.parse(localStorage.getItem('hustle-boss-v1'))}));
  assert.equal(kept.draft.first,'Alex');assert.equal(kept.draft.services[0].p,'19');assert.equal(kept.draft.reviews[0].q,'On time');assert.equal(kept.boss.jobs[0].id,'kept-job');assert.equal(kept.draft.theme,'hustle');assert.equal(kept.draft.palette,'mower');
  pass('legacy orange app / teal pet draft migrates to Energy and preserves saved work');
  assert.deepEqual(errors,[]);pass('builder style switches have no JavaScript errors');
}finally{
  if(browser)await browser.close();child.kill('SIGTERM');await rm(dir,{recursive:true,force:true});
}
console.log('Brand style checks passed: '+checks);
