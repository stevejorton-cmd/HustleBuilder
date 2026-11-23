import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
function part(start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,start);
  return source.slice(a,b);
}
const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const button=attrs=>({disabled:false,getAttribute:key=>attrs[key]||null});

function device(){
  const data=new Map([['parent-session',JSON.stringify({email:'first@example.test',token:'legacy-parent-token'})],['hb-job-code','first001']]);
  const elements=new Map();
  const el=id=>{
    if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},attributes:{},style:{},
      addEventListener(name,fn){this[name]=fn;},querySelectorAll(){return [];},
      removeAttribute(name){delete this.attributes[name];},setAttribute(name,value){this.attributes[name]=value;},focus(){this.focused=true;}});
    return elements.get(id);
  };
  let modalOpen=false,parentVerified=true,consent=true,reloads=0;
  const listeners=new Map(),bodyChildren=[{id:'private-app',tagName:'MAIN',style:{},inert:false}];
  const context=vm.createContext({PUB_KEY:'parent-session',sessionEmail:'first@example.test',draftRecoveryBlocked:false,S:{first:'Unsaved Riley'},B:{jobs:[{customer:'Unsaved customer'}]},
    localStorage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)},
    $:el,esc,jobLabel:value=>value,copyText(){},draftWriteAllowed:()=>true,
    modalEl:{classList:{contains:()=>modalOpen}},closeModal(){modalOpen=false;},clearParentVerified(){parentVerified=false;},setConsentOn(value){consent=value;},
    confirmModal:async()=>true,document:{hidden:false,activeElement:null,body:{children:bodyChildren,appendChild:child=>bodyChildren.push(child),classList:{contains:()=>true}},addEventListener(){},
      getElementById:id=>bodyChildren.find(child=>child.id===id)||null,
      createElement:tag=>({tagName:tag.toUpperCase(),attributes:{},style:{},setAttribute(name,value){this.attributes[name]=value;},querySelector:el})},
    location:{reload(){reloads++;}},window:{addEventListener:(name,callback)=>listeners.set(name,callback)},setInterval(){},pubApi:async()=>({ok:true,jobs:[],fresh:0})});
  vm.runInContext(part('let pubMemToken="";','function calSyncOn()'),context);
  vm.runInContext(part('let jobsLoadKey=','const jobsBtn='),context);
  return {context,el,data,bodyChildren,get reloads(){return reloads;},get consent(){return consent;},get parentVerified(){return parentVerified;},get modalOpen(){return modalOpen;},openModal(){modalOpen=true;},storage(event){listeners.get('storage')(event);}};
}
const firstJob={id:'first-booking',service:'Private first-family service',firstName:'Alex',when:'Nov 25 at 4 PM',status:'confirmed',place:'Lincoln',businessKey:'first-yard',kid:'Riley',business:'Yard Crew',action:'private-first-token'};
const secondJob={...firstJob,id:'second-booking',service:'Second-family service',businessKey:'second-pets',kid:'Sam',business:'Pet Crew',action:'private-second-token'};

test('clearing a parent session closes gear and hides its account entry point',()=>{
  const h=device();let closed=0;h.context.gearClose=()=>closed++;
  vm.runInContext('gearHandle={close:gearClose};gearOpenId=10;',h.context);
  h.context.clearPrivateViews();assert.equal(closed,1);assert.equal(h.el('#myBusinessGear').hidden,true);
  assert.equal(vm.runInContext('gearHandle',h.context),null);assert.equal(vm.runInContext('gearOpenId',h.context),11);
});

test('failed sign-out keeps the parent session and loaded family controls available for retry',async()=>{
  const h=device();h.el('#jobList').innerHTML='private first-family bookings';h.el('#jobCalGoogle').attributes.href='private-feed';
  h.context.pubApi=async()=>{throw Error('offline');};
  assert.equal(await h.context.pubSignOut(),false);
  assert.equal(h.context.pubToken(),'legacy-parent-token');assert.equal(h.context.pubSession().email,'first@example.test');
  assert.equal(h.el('#jobList').innerHTML,'private first-family bookings');assert.equal(h.el('#jobCalGoogle').attributes.href,'private-feed');
  assert.equal(h.parentVerified,true);assert.equal(h.consent,true);
});

test('successful sign-out clears private lists, cached filters, calendar links, modal and parent verification',async()=>{
  const h=device();h.context.pubApi=async()=>({ok:true,jobs:[firstJob],fresh:1});await h.context.loadMyJobs();
  for(const id of ['#accountSites','#buildsBox'])h.el(id).innerHTML='private family';
  for(const id of ['#jobCalGoogle','#jobCalApple','#calGoogle','#calApple'])h.el(id).attributes.href='private-feed';
  h.el('#calLink').textContent='private-feed';h.el('#acctVenmo').value='private-parent';h.openModal();
  assert.equal(await h.context.pubSignOut(),true);
  assert.equal(h.context.pubSession(),null);assert.equal(h.context.pubToken(),'');assert.equal(h.consent,false);assert.equal(h.parentVerified,false);assert.equal(h.modalOpen,false);
  for(const id of ['#jobList','#accountSites','#buildsBox'])assert.equal(h.el(id).innerHTML,'',id);
  for(const id of ['#jobCalGoogle','#jobCalApple','#calGoogle','#calApple'])assert.equal(h.el(id).attributes.href,undefined,id);
  assert.equal(h.el('#calLink').textContent,'');assert.equal(h.el('#acctVenmo').value,'');assert.equal(h.el('#jobCal').hidden,true);assert.equal(h.el('#jobSignIn').hidden,false);
  h.context.renderFilteredJobs();assert.doesNotMatch(h.el('#jobList').innerHTML,/private-first-token|Riley/);assert.doesNotMatch(h.el('#jobKidFilter').innerHTML,/Riley/);
});

test('booking response started before sign-out cannot restore private family data afterwards',async()=>{
  const h=device(),response=deferred();h.context.pubApi=async path=>path==='/api/auth/logout'?{ok:true}:response.promise;
  const pending=h.context.loadMyJobs();assert.equal(await h.context.pubSignOut(),true);
  response.resolve({ok:true,jobs:[firstJob],fresh:1});await pending;
  assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.el('#jobBadge').hidden,true);assert.equal(h.el('#jobSignIn').hidden,false);assert.equal(h.el('#jobFilters').hidden,true);
});

test('a late first-family refresh cannot replace second-family bookings or filter choices',async()=>{
  const h=device(),firstResponse=deferred();h.context.pubApi=()=>firstResponse.promise;
  const pending=h.context.loadMyJobs();h.context.clearPrivateViews();
  h.data.set('parent-session',JSON.stringify({email:'second@example.test'}));h.data.set('hb-job-code','second01');h.context.sessionEmail='second@example.test';
  h.context.pubApi=async()=>({ok:true,jobs:[secondJob],fresh:0});await h.context.loadMyJobs();
  firstResponse.resolve({ok:true,jobs:[firstJob],fresh:1});await pending;
  assert.match(h.el('#jobList').innerHTML,/Second-family service/);assert.doesNotMatch(h.el('#jobList').innerHTML,/private-first-token|Riley/);assert.doesNotMatch(h.el('#jobKidFilter').innerHTML,/Riley/);assert.equal(h.el('#jobBadge').hidden,true);
});

test('refresh network failure preserves loaded bookings and offers a retry without claiming success',async()=>{
  const h=device();h.context.pubApi=async()=>({ok:true,jobs:[firstJob],fresh:1});await h.context.loadMyJobs();
  const loaded=h.el('#jobList').innerHTML;h.context.pubApi=async()=>{throw Error('offline');};await h.context.loadMyJobs();
  assert.equal(h.el('#jobList').innerHTML,loaded);assert.match(h.el('#jobStatus').textContent,/Check your connection.*Refresh requests/);assert.equal(h.el('#refreshJobs').disabled,false);
});

test('expired parent display cache with a valid kid code cannot hide parent sign-in or claim parent controls',async()=>{
  const h=device(),kidJob={...firstJob,canAskCancel:true};delete kidJob.action;
  h.context.pubApi=async()=>({ok:true,parentAuthenticated:false,jobs:[kidJob],fresh:0});await h.context.loadMyJobs();
  assert.equal(h.el('#jobSignIn').hidden,false);assert.match(h.el('#jobStatus').textContent,/A parent confirms/);assert.doesNotMatch(h.el('#jobList').innerHTML,/data-job=/);assert.match(h.el('#jobList').innerHTML,/Ask my parent to cancel/);
});

test('a verified parent with no bookings still sees the authenticated parent inbox',async()=>{
  const h=device();h.context.pubApi=async()=>({ok:true,parentAuthenticated:true,jobs:[],fresh:0});await h.context.loadMyJobs();
  assert.equal(h.el('#jobSignIn').hidden,true);assert.match(h.el('#jobStatus').textContent,/Up to date/);
});

test('late parent mutation failure cannot replace a new family status or reload old bookings',async()=>{
  const h=device(),response=deferred();let calls=0;h.context.pubApi=()=>{calls++;return response.promise;};
  const pending=h.context.updateMyJob(button({'data-job':'private-first-token','data-st':'done'}));
  h.context.clearPrivateViews();h.context.sessionEmail='second@example.test';h.el('#jobStatus').textContent='Second-family ready';
  response.reject(Error('offline'));await pending;
  assert.equal(calls,1);assert.equal(h.el('#jobStatus').textContent,'Second-family ready');assert.equal(h.el('#jobList').innerHTML,'');
});

test('another-tab parent switch hides private data and locks edits without changing unsaved or saved drafts',()=>{
  const h=device(),savedDraft=JSON.stringify({first:'Saved other-family work'});
  h.data.set('draft',savedDraft);h.el('#jobList').innerHTML='private-first-token';h.openModal();
  const oldValue=h.data.get('parent-session'),newValue=JSON.stringify({email:'second@example.test'});h.data.set('parent-session',newValue);
  h.storage({key:'parent-session',oldValue,newValue,storageArea:h.context.localStorage});
  assert.equal(h.context.sessionEmail,'');assert.equal(h.context.draftRecoveryBlocked,true);assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.modalOpen,false);
  assert.equal(h.bodyChildren[0].inert,true);assert.equal(h.bodyChildren[0].style.visibility,'hidden');
  const overlay=h.bodyChildren.find(child=>child.id==='sharedSessionLock');assert.ok(overlay);assert.equal(overlay.attributes.role,'alertdialog');assert.match(overlay.innerHTML,/Reloading discards unsaved edits/);
  assert.equal(h.context.S.first,'Unsaved Riley');assert.equal(h.context.B.jobs[0].customer,'Unsaved customer');assert.equal(h.data.get('draft'),savedDraft);assert.equal(h.data.get('parent-session'),newValue);
  assert.equal(h.reloads,0);h.el('#sharedSessionReload').onclick();assert.equal(h.reloads,1);
});

test('same-parent display updates in another tab do not hide the current family or discard edits',()=>{
  const h=device();h.storage({key:'parent-session',oldValue:JSON.stringify({email:'FIRST@example.test'}),newValue:JSON.stringify({email:'first@example.test',slug:'another-kid'})});
  assert.equal(h.bodyChildren.length,1);assert.equal(h.context.sessionEmail,'first@example.test');assert.equal(h.context.draftRecoveryBlocked,false);assert.equal(h.context.S.first,'Unsaved Riley');
});

test('forgetting a kid code in another tab immediately clears details and invalidates pending refreshes without changing drafts',async()=>{
  const h=device(),response=deferred(),savedDraft=JSON.stringify({first:'Saved Riley'});
  h.data.delete('parent-session');h.data.delete('hb-job-code');h.context.sessionEmail='';
  h.data.set('draft',savedDraft);h.data.set('hb-kid-jobs-code','family01');
  const kidJob={...firstJob,canAskCancel:true};delete kidJob.action;
  h.context.pubApi=async()=>({ok:true,parentAuthenticated:false,jobs:[kidJob],fresh:1});await h.context.loadMyJobs();
  assert.match(h.el('#jobList').innerHTML,/Private first-family service/);
  h.el('#kidJobsCodeInput').value='family01';h.el('#forgetKidJobs').hidden=false;
  h.context.pubApi=()=>response.promise;const pending=h.context.loadMyJobs();
  h.data.delete('hb-kid-jobs-code');
  h.storage({key:'hb-kid-jobs-code',oldValue:'family01',newValue:null,storageArea:h.context.localStorage});
  assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.el('#jobFilters').hidden,true);assert.equal(h.el('#forgetKidJobs').hidden,true);assert.equal(h.el('#kidJobsCodeInput').value,'');assert.match(h.el('#kidJobsStatus').textContent,/forgotten in another tab/);
  response.resolve({ok:true,parentAuthenticated:false,jobs:[kidJob],fresh:1});await pending;
  assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.el('#jobBadge').hidden,true);
  assert.equal(h.context.draftRecoveryBlocked,false);assert.equal(h.bodyChildren.some(child=>child.id==='sharedSessionLock'),false);
  assert.equal(h.context.S.first,'Unsaved Riley');assert.equal(h.context.B.jobs[0].customer,'Unsaved customer');assert.equal(h.data.get('draft'),savedDraft);
});

test('switching a kid code in another tab removes old family details and rejects an old response before loading the new family',async()=>{
  const h=device(),response=deferred();h.data.delete('parent-session');h.data.delete('hb-job-code');h.context.sessionEmail='';
  h.data.set('hb-kid-jobs-code','family01');
  const kidJob={...firstJob,canAskCancel:true},nextKidJob={...secondJob,canAskCancel:true};delete kidJob.action;delete nextKidJob.action;
  h.context.pubApi=async()=>({ok:true,parentAuthenticated:false,jobs:[kidJob],fresh:1});await h.context.loadMyJobs();
  h.context.pubApi=()=>response.promise;const pending=h.context.loadMyJobs();
  h.data.set('hb-kid-jobs-code','family02');
  h.storage({key:'hb-kid-jobs-code',oldValue:'family01',newValue:'family02',storageArea:h.context.localStorage});
  assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.el('#forgetKidJobs').hidden,false);assert.match(h.el('#kidJobsStatus').textContent,/changed in another tab/);
  response.resolve({ok:true,parentAuthenticated:false,jobs:[kidJob],fresh:1});await pending;
  assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.context.draftRecoveryBlocked,false);assert.equal(h.context.S.first,'Unsaved Riley');
  h.context.pubApi=async()=>({ok:true,parentAuthenticated:false,jobs:[nextKidJob],fresh:0});await h.context.loadMyJobs();
  assert.match(h.el('#jobList').innerHTML,/Second-family service/);assert.doesNotMatch(h.el('#jobList').innerHTML,/Private first-family service|data-job=/);assert.doesNotMatch(h.el('#jobKidFilter').innerHTML,/Riley/);
});

test('another-tab local-storage clear locks the family and an already pending response cannot restore it',async()=>{
  const h=device(),response=deferred();h.context.pubApi=()=>response.promise;const pending=h.context.loadMyJobs();
  h.data.clear();h.storage({key:null,oldValue:null,newValue:null});response.resolve({ok:true,parentAuthenticated:true,jobs:[firstJob],fresh:1});await pending;
  assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.el('#jobBadge').hidden,true);assert.equal(h.context.draftRecoveryBlocked,true);assert.ok(h.bodyChildren.find(child=>child.id==='sharedSessionLock'));
});
