import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
const part=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert.ok(i>=0&&j>i,a);return source.slice(i,j);};
const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const button=attrs=>({disabled:false,getAttribute:k=>attrs[k]||null});
const job={id:'request-1',businessKey:'yard',kid:'Taylor',service:'Leaf raking',firstName:'Sam',place:'Lincoln',when:'Nov 25 at 4 PM',status:'new',action:'parent-action'};
const hint={kind:'weekly',label:'Weekly visits',maxCount:8,defaultCount:4,requiresCount:true,start:'2026-11-25T16:00'};
function inbox(){
  const els=new Map(),controls=[];
  const el=id=>{if(!els.has(id))els.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},addEventListener(n,fn){this[n]=fn;},querySelectorAll(selector){assert.match(selector,/select\[data-series-count\]/);return controls;}});return els.get(id);};
  const c=vm.createContext({privateViewEpoch:0,privateViewKey:()=>String(c.privateViewEpoch),draftWriteAllowed:()=>true,clearPrivateViews(){},localStorage:{getItem:()=>''},kidJobsCode:()=>'',pubSession:()=>({email:'parent@example.test'}),pubToken:()=>'', $:el,esc,jobLabel:s=>s,copyText(){},confirmModal:async()=>false,document:{hidden:false,activeElement:null,getElementById:id=>el('#'+id),body:{classList:{contains:()=>true}},addEventListener(){}},window:{addEventListener(){}},modalEl:{classList:{contains:()=>false}},setInterval(){},pubApi:async()=>({ok:true,jobs:[],fresh:0})});
  vm.runInContext(part('let jobsLoadKey=','const jobsBtn='),c);
  return {c,el,controls,async render(jobs){c.pubApi=async()=>({ok:true,jobs,fresh:0});await c.loadMyJobs();return el('#jobList').innerHTML;}};
}

test('parent can choose bounded weekly visits with a default of four and the exact approval start',async()=>{
  const h=inbox(),html=await h.render([{...job,recurrence:hint}]);
  assert.match(html,/Number of visits, including this booking/);
  assert.match(html,/<option value="2">2 visits<\/option>/);
  assert.match(html,/<option value="4" selected>4 visits<\/option>/);
  assert.match(html,/<option value="8">8 visits<\/option>/);
  assert.doesNotMatch(html,/<option value="(?:1|9)"/);
  assert.match(html,/data-st="approve-series" data-start="2026-11-25T16:00"/);
  assert.match(html,/until a parent approves/);
  const capped=await h.render([{...job,recurrence:{...hint,maxCount:3,defaultCount:7}}]);
  assert.match(capped,/<option value="3" selected>/);assert.doesNotMatch(capped,/<option value="4"/);
  const rescheduling=await h.render([{...job,recurrence:hint,reschedule:{start:'2026-12-01T16:00'}}]);
  assert.doesNotMatch(rescheduling,/data-st="approve-series"/);
});

test('series labels are visible to kids but repeating controls require parent actions',async()=>{
  const h=inbox(),html=await h.render([{...job,action:null,canAskCancel:true,series:{index:2,total:4,kind:'weekly'},recurrence:hint}]);
  assert.match(html,/Visit 2 of 4/);assert.match(html,/Weekly visits/);
  assert.doesNotMatch(html,/data-st="(?:approve-series|cancel-series)"|data-series-count/);
  assert.match(html,/Ask my parent to cancel/);
});

test('parent can cancel remaining series visits from completed or cancelled cards without approving again',async()=>{
  const h=inbox();
  for(const status of ['new','confirmed','done','cancelled']){
    const html=await h.render([{...job,status,series:{index:1,total:4,kind:'biweekly'},recurrence:hint}]);
    assert.match(html,/Visit 1 of 4/);assert.match(html,/Visits every other week/);
    assert.match(html,/data-st="cancel-series"/);assert.doesNotMatch(html,/data-st="approve-series"/);
  }
});

test('away visits explain the full date range without asking for a weekly count',async()=>{
  const h=inbox(),html=await h.render([{...job,recurrence:{...hint,kind:'away',label:'Daily visits during the away dates',maxCount:14,requiresCount:false}}]);
  assert.match(html,/one visit on each remaining away date/);assert.match(html,/up to 14 days/);
  assert.doesNotMatch(html,/data-series-count|<option value=/);assert.match(html,/data-count-id=""/);
  let body,prompt;h.c.confirmModal=async text=>{prompt=text;return true;};h.c.pubApi=async(path,opts)=>{if(path.includes('/api/job/'))body=opts.body;return {ok:true,jobs:[],message:'Notices queued.'};};
  await h.c.updateMyJob(button({'data-job':'parent-action','data-st':'approve-series','data-start':hint.start,'data-series-label':'Daily visits during the away dates'}));
  assert.match(prompt,/original booking and one visit on each remaining away date/);
  assert.equal(body.start,hint.start);assert.equal(Object.hasOwn(body,'count'),false);assert.equal(body.status,'approve-series');
});

test('approval snapshots the reviewed numeric count and disables count edits during review and saving',async()=>{
  const h=inbox(),select=h.el('#count-A');select.value='4';h.controls.push(select);
  let finishReview,finishSave,prompt,calls=[];
  h.c.confirmModal=text=>{prompt=text;assert.equal(select.disabled,true);return new Promise(resolve=>finishReview=resolve);};
  h.c.pubApi=(path,opts)=>{calls.push({path,opts});if(path.includes('/api/job/')){assert.equal(select.disabled,true);return new Promise(resolve=>finishSave=resolve);}return Promise.resolve({ok:true,jobs:[]});};
  const pending=h.c.updateMyJob(button({'data-job':'parent-action','data-st':'approve-series','data-start':hint.start,'data-series-label':'Weekly visits','data-count-id':'count-A'}));
  assert.equal(select.disabled,true);assert.match(prompt,/original booking plus 3 more visits/);assert.match(prompt,/Email notices are queued/);
  select.value='8';finishReview(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);assert.equal(calls[0].opts.body.count,4);assert.equal(typeof calls[0].opts.body.count,'number');assert.equal(calls[0].opts.body.start,hint.start);assert.equal(select.disabled,true);
  finishSave({ok:true,message:'Repeating visits confirmed. Email notices queued.'});await pending;
  assert.equal(select.disabled,false);assert.match(h.el('#jobStatus').textContent,/Email notices queued/);
});

test('declining or invalidating a reviewed approval sends no schedule and unlocks the count',async()=>{
  for(const changedFamily of [false,true]){
    const h=inbox(),select=h.el('#count-A');select.value='4';let finish,calls=0;
    h.c.confirmModal=()=>new Promise(resolve=>finish=resolve);h.c.pubApi=async()=>{calls++;return {ok:true};};
    const pending=h.c.updateMyJob(button({'data-job':'parent-action','data-st':'approve-series','data-start':hint.start,'data-count-id':'count-A'}));
    if(changedFamily)h.c.privateViewEpoch++;finish(changedFamily);await pending;
    assert.equal(calls,0);assert.equal(select.disabled,false);
  }
});

test('invalid repeat counts and missing proposal times are rejected before approval',async()=>{
  for(const value of ['1','9','3.5','not-a-count']){
    const h=inbox();h.el('#count-A').value=value;let prompts=0,calls=0;
    h.c.confirmModal=async()=>{prompts++;return true;};h.c.pubApi=async()=>{calls++;return {ok:true};};
    await h.c.updateMyJob(button({'data-job':'parent-action','data-st':'approve-series','data-start':hint.start,'data-count-id':'count-A'}));
    assert.equal(prompts,0);assert.equal(calls,0);assert.match(h.el('#jobStatus').textContent,/Choose 2 to 8/);
  }
  const h=inbox();await h.c.updateMyJob(button({'data-job':'parent-action','data-st':'approve-series'}));assert.match(h.el('#jobStatus').textContent,/Refresh requests/);
});

test('cancelling a series requires approval and describes only future uncompleted visits',async()=>{
  const h=inbox();let calls=[],prompt;
  h.c.confirmModal=async text=>{prompt=text;return false;};h.c.pubApi=async(path,opts)=>{calls.push({path,opts});return {ok:true,jobs:[],message:'Future visits cancelled.'};};
  const btn=button({'data-job':'parent-action','data-st':'cancel-series'});await h.c.updateMyJob(btn);assert.equal(calls.length,0);
  assert.match(prompt,/Only future, uncompleted visits/);assert.match(prompt,/other bookings are unaffected/);assert.match(prompt,/notices are queued/);
  h.c.confirmModal=async()=>true;await h.c.updateMyJob(btn);assert.equal(calls[0].opts.body.status,'cancel-series');assert.equal(calls[0].opts.body.count,undefined);
});

test('untrusted recurrence and series metadata cannot inject markup or approval controls',async()=>{
  const h=inbox(),html=await h.render([{...job,action:'parent"/><img src=x>',recurrence:{...hint,label:'<img src=x>',start:'" onclick="bad()'}},{...job,action:null,series:{index:'<img src=x>',total:4,kind:'<script>'}}]);
  assert.doesNotMatch(html,/<img|<script|data-start="" onclick=/);assert.match(html,/&lt;img/);
  assert.match(html,/id="job-series-count-parent%22%2F%3E%3Cimg%20src%3Dx%3E"/);
});
