import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {extractBuilderParts,demoCfg} from './site-fixture.mjs';
const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
function part(a,b){const start=source.indexOf(a),end=source.indexOf(b,start+a.length);assert.ok(start>=0&&end>start,a);return source.slice(start,end);}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('failed logout keeps authentication and consent; successful logout clears private views',async()=>{
 let saved='parent',consent=true,cleared=0;
 const c=vm.createContext({pubMemToken:'token',pubSaveSession:s=>saved=s,setConsentOn:v=>consent=v,clearPrivateViews:()=>cleared++,pubApi:async()=>{throw Error('offline');}});
 vm.runInContext(part('async function pubSignOut(){','function sharedSessionEmail('),c);
 assert.equal(await c.pubSignOut(),false);assert.equal(c.pubMemToken,'token');assert.equal(saved,'parent');assert.equal(consent,true);assert.equal(cleared,0);
 c.pubApi=async()=>({ok:false,httpStatus:503});assert.equal(await c.pubSignOut(),false);assert.equal(cleared,0);
 c.pubApi=async()=>({ok:true});assert.equal(await c.pubSignOut(),true);assert.equal(c.pubMemToken,'');assert.equal(saved,null);assert.equal(consent,false);assert.equal(cleared,1);
 c.pubSaveSession=()=>{throw Error('storage blocked');};c.setConsentOn=()=>{throw Error('storage blocked');};assert.equal(await c.pubSignOut(),true);assert.equal(cleared,2);
});
function inbox(){
 const els=new Map(),intervals=[],events={};let mode=true;
 const el=id=>{if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},attrs:{href:'private-calendar-token'},removeAttribute(n){delete this.attrs[n];},addEventListener(n,fn){this[n]=fn;},querySelectorAll(){return [];}});return els.get(id);};
 const c=vm.createContext({sessionEmail:'one@example.com',pubSession:()=>({email:c.sessionEmail}),pubToken:()=>c.sessionEmail,localStorage:{getItem:()=>''},$:el,clearParentVerified(){},draftWriteAllowed:()=>true,esc:s=>String(s??''),jobLabel:s=>s,copyText(){},confirmModal:async()=>false,document:{hidden:false,activeElement:null,body:{classList:{contains:()=>mode}},addEventListener:(name,fn)=>events[name]=fn},window:{addEventListener:(name,fn)=>events[name]=fn},modalEl:{classList:{contains:()=>false}},setInterval:(fn,ms)=>intervals.push({fn,ms}),pubApi:async()=>({ok:true,jobs:[],fresh:0})});
 vm.runInContext(part('let privateViewEpoch=','function publishOrigin(')+part('let jobsLoadKey=','const jobsBtn='),c);
 return {c,el,intervals,events,setMode:v=>mode=v};
}
test('sign-out clears booking action tokens, account cards and private calendar links',()=>{
 const h=inbox();h.el('#jobList').innerHTML='secret action token';h.el('#accountSites').innerHTML='private family';h.c.clearPrivateViews();
 assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.el('#accountSites').innerHTML,'');
 for(const id of ['#jobCalGoogle','#jobCalApple','#calGoogle','#calApple'])assert.equal(h.el(id).attrs.href,undefined);
 assert.equal(h.el('#jobCal').hidden,true);assert.equal(h.el('#jobSignIn').hidden,false);
});
test('a late request response cannot refill private details after sign-out',async()=>{
 const h=inbox(),p=deferred();h.c.pubApi=()=>p.promise;const loading=h.c.loadMyJobs();
 h.c.clearPrivateViews();h.c.sessionEmail='';p.resolve({ok:true,jobs:[{service:'Private job',firstName:'Casey',action:'secret',status:'new'}]});await loading;
 assert.equal(h.el('#jobList').innerHTML,'');assert.doesNotMatch(h.el('#jobStatus').textContent,/Up to date/);
});
test('a late cloud draft save cannot replace the code of another build or a signed-out view',async()=>{
 for(const change of ['build','session','none']){
  const pending=deferred(),data=new Map([['hb-draft','firstkid']]);
  const c=vm.createContext({privateViewEpoch:0,draftWriteAllowed:()=>true,publishOrigin:()=>true,consentOn:()=>true,localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},draftPayload:()=>({first:'Alex'}),pubApi:()=>pending.promise});
  vm.runInContext(part('async function saveDraft(){','function applyDraft('),c);const saving=c.saveDraft();
  if(change==='build')data.set('hb-draft','nextkid1');if(change==='session')c.privateViewEpoch++;
  pending.resolve({ok:true,code:'returned'});await saving;
  assert.equal(data.get('hb-draft'),change==='build'?'nextkid1':change==='session'?'firstkid':'returned');
 }
});
test('polling waits for a visible jobs screen and overlapping refreshes share a request',async()=>{
 const h=inbox(),p=deferred();let calls=0;h.c.pubApi=()=>{calls++;return p.promise;};assert.ok(h.intervals[0].ms>=30000);
 h.setMode(false);h.intervals[0].fn();assert.equal(calls,0);
 h.setMode(true);h.c.document.hidden=true;h.intervals[0].fn();assert.equal(calls,0);
 h.c.document.hidden=false;h.intervals[0].fn();h.intervals[0].fn();assert.equal(calls,1);
 p.resolve({ok:true,jobs:[],fresh:0});await new Promise(resolve=>setImmediate(resolve));assert.equal(h.el('#refreshJobs').disabled,false);
});
test('request action failures explain recovery and restore controls; cancelling requires confirmation',async()=>{
 const h=inbox();let calls=0;const btn={disabled:false,getAttribute:k=>k==='data-st'?'cancelled':'token'};
 h.el('#jobList').querySelectorAll=()=>[btn];h.c.pubApi=async()=>{calls++;return {ok:false};};
 await h.c.updateMyJob(btn);assert.equal(calls,0);
 h.c.confirmModal=async()=>true;await h.c.updateMyJob(btn);assert.equal(calls,1);assert.match(h.el('#jobStatus').textContent,/Could not save/);assert.equal(btn.disabled,false);
 h.c.pubApi=async()=>{throw Error('offline');};await h.c.updateMyJob(btn);assert.match(h.el('#jobStatus').textContent,/Refresh requests/);assert.equal(btn.disabled,false);
});
test('parent job cards offer a customer payment link to copy instead of paying the family themselves',async()=>{
 const h=inbox();h.c.pubApi=async()=>({ok:true,jobs:[{service:'Cleanup',status:'done',action:'token',venmoUrl:'https://venmo.com/family'}],fresh:0});await h.c.loadMyJobs();
 assert.match(h.el('#jobList').innerHTML,/Copy customer payment link/);assert.doesNotMatch(h.el('#jobList').innerHTML,/>Pay with Venmo</);
});
test('returning to Flyers preserves the selected flyer and poster designs',()=>{
 const nodes=new Map();const c=vm.createContext({S:{flyerStyle:'bold',studio:{bg:'accent'}},document:{body:{classList:{toggle(){}}}},$:id=>{if(!nodes.has(id))nodes.set(id,{setAttribute(){}});return nodes.get(id);},save(){},syncLiveUrlFields(){},renderFlyerChips(){},refreshFlyers(){},window:{scrollTo(){}}});
 vm.runInContext(part('function setMode(m){','$("#mBuild").onclick='),c);c.setMode('flyers');c.setMode('build');c.setMode('flyers');assert.equal(c.S.flyerStyle,'bold');assert.equal(c.S.studio.bg,'accent');
});
function builds(failKey=''){
 const data=new Map([['hb-draft','build001']]);
 const c=vm.createContext({S:{first:'Alex',bizName:'Alex’s Cleanup',proof:[{a:'image'.repeat(150000),b:'after'}]},B:{jobs:[{id:'paid-job',amount:12}],upcoming:[],costs:[]},localStorage:{getItem:k=>data.get(k)??null,setItem(k,v){if(k===failKey)throw Error('quota');data.set(k,v);}},draftWriteAllowed:()=>true,draftRecoveryNotice(){},publishOrigin:()=> 'https://test.invalid',consentOn:()=>false,clearTimeout(){},draftTimer:0});
 vm.runInContext(part('const BUILDS_KEY=','function clearBuildLeftovers(){'),c);return {c,data};
}
test('build switching refuses to continue if photos, registry or job records cannot be saved',async()=>{
 for(const key of ['hb-local-drafts','hb-builds','hb-boss-build001']){const h=builds(key);assert.equal(await h.c.stashCurrentBuild(),false,key);assert.equal(h.c.S.first,'Alex');assert.equal(h.c.B.jobs[0].id,'paid-job');}
});
test('saved local builds retain large photos and a separate job log',async()=>{
 const h=builds();assert.equal(await h.c.stashCurrentBuild(),true);
 const saved=JSON.parse(h.data.get('hb-local-drafts')).build001;assert.equal(saved.proof[0].a,h.c.S.proof[0].a);assert.equal(JSON.parse(h.data.get('hb-boss-build001')).jobs[0].id,'paid-job');
});
test('saved website copies do not offer a generic booking email and can point to the live form',()=>{
 const {genSite}=extractBuilderParts(source);const html=genSite(demoCfg({publish:null,publicUrl:'https://hustlebuilder.org/alex-cleanup',email:'legacy@example.com'}));
 assert.doesNotMatch(html,/mailto:bookings@|id="sendMail"/);assert.match(html,/Request on my live website/);
});
test('pet-care requests validate pet counts and date ranges before building a request',()=>{
 const nodes={err:{textContent:''},nm:{value:'Casey'},addr:{value:'123 Example'},note:{value:''},ct:{value:'casey@example.com'},freq:{value:"While I'm away"},awayFrom:{value:''},awayTo:{value:''},petCount:{value:'1'},out:{value:''},outWrap:{hidden:true},timeWrap:{hidden:true}};
 const c=vm.createContext({$:id=>nodes[id],C:{pet:true,first:'Alex',biz:'Pet Care'},picked:new Date(),otherOn:()=>false,val:id=>nodes[id]?.value||'',longDate:()=> 'Monday',petLine:()=>'',sel:{value:'Pet visit'},calLine:()=>''});vm.runInContext(part('  function build(needContact){','  var t=$("sendText")'),c);
 assert.equal(c.build(true),null);assert.match(nodes.err.textContent,/first and last day/);
 nodes.awayFrom.value='2026-12-10';nodes.awayTo.value='2026-12-09';assert.equal(c.build(true),null);assert.match(nodes.err.textContent,/on or after/);
 nodes.awayTo.value='2026-12-12';nodes.petCount.value='0';assert.equal(c.build(true),null);assert.match(nodes.err.textContent,/whole number/);
 nodes.petCount.value='2';assert.match(c.build(true),/Pet visit/);
});
