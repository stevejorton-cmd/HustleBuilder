import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
const part=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert.ok(i>=0&&j>i,a);return source.slice(i,j);};
const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
function inbox(parent=false){
  const els=new Map(),data=new Map([['hb-job-code','family01']]);
  const el=id=>{if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',hidden:false,disabled:false,dataset:{},addEventListener(n,fn){this[n]=fn;},querySelectorAll(){return [];}});return els.get(id);};
  const c=vm.createContext({privateViewEpoch:0,publishIdentityChecks:0,privateViewKey:()=>String(c.privateViewEpoch),draftWriteAllowed:()=>true,clearPrivateViews(){},localStorage:{getItem:k=>data.get(k)||''},pubSession:()=>parent?{email:'parent@example.test'}:null,pubToken:()=>parent?'token':'',$:el,esc,jobLabel:s=>s,copyText(){},confirmModal:async()=>false,document:{hidden:false,activeElement:null,body:{classList:{contains:()=>true}},addEventListener(){}},window:{addEventListener(){}},modalEl:{classList:{contains:()=>false}},setInterval(){},pubApi:async()=>({ok:true,jobs:[],fresh:0})});
  vm.runInContext(part('function kidJobsCode(){','function privateViewKey(){'),c);
  vm.runInContext(part('let jobsLoadKey=','const jobsBtn='),c);
  return {c,el,data};
}
const job={id:'request1',service:'Yard cleanup',firstName:'Casey',when:'Nov 25 at 4 PM',status:'confirmed',place:'Lincoln'};
const button=attrs=>({disabled:false,getAttribute:k=>attrs[k]||null});
test('kid cancellation request is offered only for active eligible requests and pending requests stay active',async()=>{
  const h=inbox();h.c.pubApi=async()=>({ok:true,jobs:[{...job,canAskCancel:true}],fresh:0});await h.c.loadMyJobs();
  assert.match(h.el('#jobList').innerHTML,/Ask my parent to cancel/);assert.doesNotMatch(h.el('#jobList').innerHTML,/data-job=/);
  h.c.pubApi=async()=>({ok:true,jobs:[{...job,canAskCancel:true,cancelRequested:true}],fresh:0});await h.c.loadMyJobs();
  assert.match(h.el('#jobList').innerHTML,/stays active until your parent cancels/);assert.doesNotMatch(h.el('#jobList').innerHTML,/data-ask-cancel=/);
  for(const status of ['cancelled','done']){h.c.pubApi=async()=>({ok:true,jobs:[{...job,status,canAskCancel:true,cancelRequested:true,reschedule:{start:'2026-12-01T16:00'}}]});await h.c.loadMyJobs();assert.doesNotMatch(h.el('#jobList').innerHTML,/data-ask-cancel=|Accept new time|New time requested|asked to cancel/);}
});
test('parent sees cancellation request and proposed time with approval bound to that exact proposal',async()=>{
  const h=inbox(true);h.c.pubApi=async()=>({ok:true,jobs:[{...job,action:'parentsecret',cancelRequested:true,reschedule:{start:'2026-12-01T16:00',when:'Dec 1 at 4 PM'}}]});await h.c.loadMyJobs();
  const html=h.el('#jobList').innerHTML;assert.match(html,/Your kid asked to cancel/);assert.match(html,/Keep booking/);assert.match(html,/Accept new time/);assert.match(html,/Keep original time/);assert.match(html,/data-start="2026-12-01T16:00"/);assert.doesNotMatch(html,/Ask my parent to cancel/);
  h.c.pubApi=async()=>({ok:true,jobs:[{...job,action:'parentsecret',status:'cancelled',reschedule:{start:'2026-12-01T16:00'}}]});await h.c.loadMyJobs();assert.doesNotMatch(h.el('#jobList').innerHTML,/data-job=/);
});
test('asking a parent requires explicit confirmation and sends only family code and request id',async()=>{
  const h=inbox(),btn=button({'data-ask-cancel':'request1'});let calls=[];
  h.c.pubApi=async(path,opts)=>{calls.push({path,opts});return path.includes('cancel-request')?{ok:true,message:'Request queued for your parent.'}:{ok:true,jobs:[{...job,cancelRequested:true}]};};
  await h.c.askMyParentToCancel(btn);assert.equal(calls.length,0);
  h.c.confirmModal=async()=>true;await h.c.askMyParentToCancel(btn);
  assert.equal(calls[0].path,'/api/my-jobs/cancel-request');assert.equal(JSON.stringify(calls[0].opts.body),JSON.stringify({code:'family01',id:'request1'}));assert.equal(h.el('#jobStatus').textContent,'Request queued for your parent.');
});
test('parent reschedule decisions require confirmation, include exact proposed start, and show returned notice',async()=>{
  for(const status of ['accept-reschedule','decline-reschedule']){
    const h=inbox(true),btn=button({'data-job':'parenttoken','data-st':status,'data-start':'2026-12-01T16:00'});let calls=[];
    h.c.pubApi=async(path,opts)=>{calls.push({path,opts});return path.includes('/api/job/')?{ok:true,status:'confirmed',message:'Email notices queued. Contact phone-only customers directly.'}:{ok:true,jobs:[]};};
    await h.c.updateMyJob(btn);assert.equal(calls.length,0);
    h.c.confirmModal=async()=>true;await h.c.updateMyJob(btn);assert.equal(calls[0].path,'/api/job/parenttoken');assert.equal(calls[0].opts.body.start,'2026-12-01T16:00');assert.equal(calls[0].opts.body.status,status);assert.equal(calls[0].opts.body.json,true);assert.match(h.el('#jobStatus').textContent,/Email notices queued/);
  }
});
test('a delayed parent prompt cannot submit for a family after the private view changes',async()=>{
  const h=inbox();let resolve,calls=0;h.c.confirmModal=()=>new Promise(r=>resolve=r);h.c.pubApi=async()=>{calls++;return {ok:true};};
  const pending=h.c.askMyParentToCancel(button({'data-ask-cancel':'request1'}));h.c.privateViewEpoch++;resolve(true);await pending;assert.equal(calls,0);
});
test('untrusted requested time is escaped and cannot create controls',async()=>{
  const h=inbox(true);h.c.pubApi=async()=>({ok:true,jobs:[{...job,action:'parenttoken',reschedule:{start:'2026-12-01T16:00',when:'<img src=x onerror=alert(1)>'}}]});await h.c.loadMyJobs();assert.doesNotMatch(h.el('#jobList').innerHTML,/<img/);assert.match(h.el('#jobList').innerHTML,/&lt;img/);
});

test('keeping a booking requires confirmation and dismisses only the kid cancellation request',async()=>{
  const h=inbox(true),btn=button({'data-job':'parenttoken','data-st':'keep-booking'});let calls=[];
  h.c.pubApi=async(path,opts)=>{calls.push({path,opts});return path.includes('/api/job/')?{ok:true,status:'confirmed',message:'Cancellation request dismissed. Booking unchanged.'}:{ok:true,jobs:[]};};
  await h.c.updateMyJob(btn);assert.equal(calls.length,0);h.c.confirmModal=async()=>true;await h.c.updateMyJob(btn);
  assert.equal(calls[0].opts.body.status,'keep-booking');assert.equal(calls[0].opts.body.start,undefined);assert.match(h.el('#jobStatus').textContent,/Booking unchanged/);
});
test('jobs entry opens My jobs and suppresses examples without granting parent access',async()=>{
  const c=vm.createContext({introSeen:()=>false,URLSearchParams});
  vm.runInContext(part('function shouldOpenIntro(params){','if(shouldOpenIntro(entryParams)'),c);
  assert.equal(c.shouldOpenIntro(new URLSearchParams('jobs=1')),false);
  assert.match(source,/else if\(startQ.get\("jobs"\)\)setMode\("boss"\)/);
  const h=inbox();h.data.clear();let cleared=0,calls=0;h.c.clearPrivateViews=()=>cleared++;h.c.pubApi=async()=>{calls++;return {ok:true};};await h.c.loadMyJobs();assert.equal(cleared,1);assert.equal(calls,0);
});

test('family filters switch siblings locally, include empty businesses, and preserve selection after refresh',async()=>{
  const h=inbox(true);let calls=0;
  const jobs=[{...job,id:'riley-job',businessKey:'riley-yard',kid:'Riley',business:'Yard Crew',action:'riley-action'},{...job,id:'quinn-job',businessKey:'quinn-pets',kid:'Quinn',business:'Pet Visits',action:'quinn-action',service:'Dog walk'}];
  const businesses=[{key:'riley-yard',kid:'Riley',business:'Yard Crew'},{key:'quinn-pets',kid:'Quinn',business:'Pet Visits'},{key:'casey-snow',kid:'Casey',business:'Snow Patrol'}];
  h.c.pubApi=async()=>{calls++;return {ok:true,jobs,businesses,fresh:1};};await h.c.loadMyJobs();
  const select=h.el('#jobKidFilter');assert.equal(h.el('#jobFilters').hidden,false);assert.match(select.innerHTML,/All kids/);assert.match(select.innerHTML,/Casey/);
  select.value='quinn-pets';select.change();assert.match(h.el('#jobList').innerHTML,/quinn-action/);assert.doesNotMatch(h.el('#jobList').innerHTML,/riley-action/);assert.match(h.el('#jobFilterSummary').textContent,/Showing 1 booking.*Quinn/);assert.equal(calls,1,'switching does not fetch or mutate bookings');
  await h.c.loadMyJobs();assert.equal(select.value,'quinn-pets');assert.doesNotMatch(h.el('#jobList').innerHTML,/riley-action/);
  select.value='casey-snow';select.change();assert.equal(h.el('#jobList').innerHTML,'');assert.equal(h.el('#jobEmpty').hidden,false);assert.match(h.el('#jobEmpty').textContent,/Casey.*yet/);
  select.value='';select.change();assert.match(h.el('#jobList').innerHTML,/riley-action/);assert.match(h.el('#jobList').innerHTML,/quinn-action/);assert.equal(h.el('#jobEmpty').hidden,true);
});
test('same-name kids remain distinct by business key and filters reset for another family',async()=>{
  const h=inbox(true);
  let jobs=[{...job,id:'one',businessKey:'sam-yard',kid:'Sam',business:'Yard',service:'First service'},{...job,id:'two',businessKey:'sam-pets',kid:'Sam',business:'Pets',service:'Second service'}];
  h.c.pubApi=async()=>({ok:true,jobs,fresh:0});await h.c.loadMyJobs();const select=h.el('#jobKidFilter');
  select.value='sam-pets';select.change();assert.match(h.el('#jobList').innerHTML,/Second service/);assert.doesNotMatch(h.el('#jobList').innerHTML,/First service/);
  h.c.privateViewEpoch++;jobs=[{...job,businessKey:'lee-snow',kid:'Lee',business:'Snow'}];await h.c.loadMyJobs();assert.equal(select.value,'');assert.doesNotMatch(select.innerHTML,/Sam/);assert.match(h.el('#jobList').innerHTML,/Lee/);assert.equal(h.el('#jobFilters').hidden,true);
  h.c.resetJobFilters();assert.equal(select.value,'');assert.equal(h.el('#jobFilterSummary').textContent,'');assert.doesNotMatch(select.innerHTML,/Lee/);
});
test('family filter labels escape customer-controlled markup and removed choices fall back to All kids',async()=>{
  const h=inbox(true);let jobs=[{...job,businessKey:'yard',kid:'<img src=x>',business:'A & B'},{...job,businessKey:'pets',kid:'Quinn',business:'Pets'}];
  h.c.pubApi=async()=>({ok:true,jobs});await h.c.loadMyJobs();const select=h.el('#jobKidFilter');assert.doesNotMatch(select.innerHTML,/<img/);assert.match(select.innerHTML,/&lt;img/);assert.match(select.innerHTML,/A &amp; B/);
  select.value='pets';select.change();jobs=[jobs[0]];await h.c.loadMyJobs();assert.equal(select.value,'');assert.equal(h.el('#jobEmpty').hidden,true);
});
