import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
function part(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function device(){
  const data=new Map(),els=new Map();
  const el=id=>{if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},attributes:{},addEventListener(n,f){this[n]=f;},querySelectorAll(){return [];},removeAttribute(k){delete this.attributes[k];}});return els.get(id);};
  const c=vm.createContext({PUB_KEY:'parent-session',sessionEmail:'',localStorage:{getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)},$:el,esc,jobLabel:s=>s,copyText(){},draftWriteAllowed:()=>false,modalEl:{classList:{contains:()=>false}},closeModal(){},clearParentVerified(){},setConsentOn(){},confirmModal:async()=>true,document:{hidden:false,activeElement:null,body:{classList:{contains:()=>true}},addEventListener(){}},window:{addEventListener(){}},setInterval(){},pubApi:async()=>({ok:true,parentAuthenticated:false,jobs:[],fresh:0})});
  vm.runInContext(part('let pubMemToken="";','function calSyncOn()'),c);
  vm.runInContext(part('function showFamilyJobsCode(me){','function showCalendar(me){'),c);
  vm.runInContext(part('let jobsLoadKey=','const jobsBtn='),c);
  return {c,el,data};
}
const job={id:'request-kid',service:'Pet walk',when:'Nov 25 at 4 PM',status:'confirmed',firstName:'Alex',place:'In your neighborhood',kid:'Sam',business:'Sam Pets',businessKey:'sam-pets',canAskCancel:true};

test('valid explicit family code opens only kid requests while leaving the owned draft locked',async()=>{
  const h=device(),paths=[];h.data.set('hb-draft-owner','parent@example.test');h.data.set('hb-website','saved family draft');
  h.el('#kidJobsCodeInput').value='Family01';h.c.pubApi=async path=>{paths.push(path);return {ok:true,parentAuthenticated:false,jobs:[job],fresh:0};};
  await h.c.openKidJobs({preventDefault(){}});
  assert.deepEqual(paths,['/api/my-jobs?code=family01','/api/my-jobs?code=family01']);
  assert.equal(h.data.get('hb-kid-jobs-code'),'family01');assert.equal(h.data.get('hb-draft-owner'),'parent@example.test');assert.equal(h.data.get('hb-website'),'saved family draft');assert.equal(h.c.draftWriteAllowed(),false);
  assert.match(h.el('#jobList').innerHTML,/Pet walk|Ask my parent to cancel/);assert.doesNotMatch(h.el('#jobList').innerHTML,/data-job=/);assert.equal(h.el('#jobSignIn').hidden,false);assert.equal(h.el('#forgetKidJobs').hidden,false);assert.equal(h.el('#kidJobsCodeInput').value,'');
});

test('invalid family code or network failure never persists a code or replaces existing access',async()=>{
  const h=device();h.data.set('hb-kid-jobs-code','family01');h.el('#kidJobsCodeInput').value='bad';let calls=0;h.c.pubApi=async()=>{calls++;throw Error('offline');};
  await h.c.openKidJobs();assert.equal(calls,0);assert.equal(h.data.get('hb-kid-jobs-code'),'family01');assert.match(h.el('#kidJobsStatus').textContent,/8-character/);
  h.el('#kidJobsCodeInput').value='family02';await h.c.openKidJobs();assert.equal(calls,1);assert.equal(h.data.get('hb-kid-jobs-code'),'family01');assert.match(h.el('#kidJobsStatus').textContent,/connection/);assert.equal(h.el('#openKidJobs').disabled,false);
  h.c.pubApi=async()=>({ok:false,error:'auth'});await h.c.openKidJobs();assert.equal(h.data.get('hb-kid-jobs-code'),'family01');assert.match(h.el('#kidJobsStatus').textContent,/Check it with your parent/);
});

test('a signed-in parent cookie prevents entering kid mode even with no parent display cache',async()=>{
  const h=device();h.el('#kidJobsCodeInput').value='family01';h.c.pubApi=async()=>({ok:true,parentAuthenticated:true,jobs:[{...job,action:'parent-capability'}],fresh:0});
  await h.c.openKidJobs();assert.equal(h.data.has('hb-kid-jobs-code'),false);assert.match(h.el('#kidJobsStatus').textContent,/sign out of the parent account/);assert.doesNotMatch(h.el('#jobList').innerHTML,/parent-capability/);
});

test('kid refresh refuses a parent response if a parent signs in during the code view',async()=>{
  const h=device();h.data.set('hb-kid-jobs-code','family01');h.c.pubApi=async()=>({ok:true,parentAuthenticated:true,jobs:[{...job,action:'parent-capability'}],fresh:0});
  await h.c.loadMyJobs();assert.equal(h.el('#jobList').innerHTML,'');assert.match(h.el('#kidJobsStatus').textContent,/parent is still signed in/);assert.equal(h.el('#jobCal').hidden,true);
});

test('forgetting a family code clears loaded details and blocks an older successful lookup',async()=>{
  const h=device();h.data.set('hb-kid-jobs-code','family01');h.c.pubApi=async()=>({ok:true,parentAuthenticated:false,jobs:[job],fresh:0});await h.c.loadMyJobs();assert.match(h.el('#jobList').innerHTML,/Pet walk/);
  let resolve;h.c.pubApi=()=>new Promise(yes=>{resolve=yes;});h.el('#kidJobsCodeInput').value='family02';const pending=h.c.openKidJobs();h.c.forgetKidJobs();resolve({ok:true,parentAuthenticated:false,jobs:[job],fresh:0});await pending;
  assert.equal(h.data.has('hb-kid-jobs-code'),false);assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.el('#forgetKidJobs').hidden,true);assert.match(h.el('#kidJobsStatus').textContent,/forgotten/);
});

test('only verified parent account data exposes a shareable code and sign-out removes it',async()=>{
  const h=device();h.c.showFamilyJobsCode({ok:true,jobCode:'family01'});assert.equal(h.el('#familyJobsCode').hidden,false);assert.equal(h.el('#familyJobsCodeValue').textContent,'family01');
  h.c.showFamilyJobsCode({jobCode:'family02'});assert.equal(h.el('#familyJobsCode').hidden,true);assert.equal(h.el('#familyJobsCodeValue').textContent,'');
  h.c.showFamilyJobsCode({ok:true,jobCode:'family01'});h.data.set('hb-kid-jobs-code','family02');h.c.pubApi=async()=>({ok:true});assert.equal(await h.c.pubSignOut(),true);assert.equal(h.data.has('hb-kid-jobs-code'),false);assert.equal(h.el('#familyJobsCode').hidden,true);assert.equal(h.el('#familyJobsCodeValue').textContent,'');
});

test('kid cancellation request uses the entered jobs code instead of a locked draft code',async()=>{
  const h=device();h.data.set('hb-kid-jobs-code','family01');h.data.set('hb-draft-code','draft002');let submitted;
  h.c.pubApi=async(path,opt)=>{if(path==='/api/my-jobs/cancel-request'){submitted=opt.body;return {ok:true,message:'Your parent has been asked.'};}return {ok:true,parentAuthenticated:false,jobs:[{...job,cancelRequested:true}],fresh:0};};
  await h.c.askMyParentToCancel({getAttribute:k=>k==='data-ask-cancel'?'request-kid':null});
  assert.equal(submitted.code,'family01');assert.equal(submitted.id,'request-kid');assert.deepEqual(Object.keys(submitted).sort(),['code','id']);assert.match(h.el('#jobStatus').textContent,/parent has been asked/);
});
