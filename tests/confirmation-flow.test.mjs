import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
function part(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function dialog(){
  const nodes=new Map(),events={},modalEvents={};
  const body={innerHTML:'',querySelector:s=>{if(!nodes.has(s))nodes.set(s,{});return nodes.get(s);}};
  const classes=new Set();
  const modal={classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},addEventListener:(name,fn)=>modalEvents[name]=fn};
  const c=vm.createContext({$:id=>id==='#modal'?modal:body,document:{getElementById:()=>({classList:{remove(){}}}),addEventListener:(name,fn)=>events[name]=fn},window:{matchMedia:()=>({matches:false})}});
  vm.runInContext(part('const modalEl=$("#modal")','let toastT;')+part('function confirmModal(','/* Which build'),c);
  return {c,nodes,body,modal,events,modalEvents};
}
test('confirmation dialogs settle for buttons, Escape, backdrop and replacement',async()=>{
  for(const action of ['yes','no','escape','backdrop','replace']){
    const h=dialog();let settled=false;
    const pending=h.c.confirmModal('Check this','Continue').then(value=>{settled=true;return value;});
    if(action==='yes')h.nodes.get('#cfYes').onclick();
    if(action==='no')h.nodes.get('#cfNo').onclick();
    if(action==='escape')h.events.keydown({key:'Escape'});
    if(action==='backdrop')h.modalEvents.click({target:h.modal});
    if(action==='replace')h.c.openModal('Another dialog');
    await Promise.resolve();assert.equal(settled,true,action);
    assert.equal(await pending,action==='yes',action);
    h.c.closeModal(); // A later close cannot change the settled decision.
  }
});
test('dialog interior clicks keep a confirmation pending',async()=>{
  const h=dialog();let settled=false;
  const pending=h.c.confirmModal('Check this','Continue').then(v=>{settled=true;return v;});
  h.modalEvents.click({target:h.body});await Promise.resolve();assert.equal(settled,false);
  h.nodes.get('#cfNo').onclick();assert.equal(await pending,false);
});
function api(payload,status=200){
  const c=vm.createContext({publishOrigin:()=> 'https://example.test',pubToken:()=>'',fetch:async()=>({status,json:async()=>payload})});
  vm.runInContext(part('async function pubApi(','function pubErr('),c);return c;
}
test('API preserves live invitation status and polling finishes',async()=>{
  const response=await api({ok:true,status:'live',url:'https://example.test/taylor'}).pubApi('/api/ask/token',{method:'GET'});
  assert.equal(response.status,'live');assert.equal(response.httpStatus,200);
  let poll,cleared=0,published='';const els={};
  const c=vm.createContext({askPoll:0,localStorage:{getItem:()=> 'token'},publishOrigin:()=> 'https://example.test',pubApi:async()=>response,setInterval:fn=>{poll=fn;return 7;},clearInterval:()=>cleared++,$:id=>els[id]||= {},showPublished:url=>published=url});
  vm.runInContext(part('function startAskPoll(){','const askBtn='),c);
  c.startAskPoll();await poll();
  assert.equal(published,response.url);assert.equal(els['#askStatus'].textContent,'Your page is up!');assert.equal(cleared,2);
});
test('API still exposes HTTP auth errors and invalid JSON safely',async()=>{
  const denied=await api({ok:false,error:'auth'},401).pubApi('/api/me',{method:'GET'});
  assert.equal(denied.httpStatus,401);
  const c=api(null);c.fetch=async()=>({status:502,json:async()=>{throw Error('invalid');}});
  const invalid=await c.pubApi('/api/me',{method:'GET'});assert.equal(invalid.httpStatus,502);assert.equal(invalid.error,'json');
});
test('preparing a customer message never confirms a job, with or without a phone',()=>{
  for(const phone of ['4025550100','']){
    const h=dialog(),job={id:'job1',customer:'Casey',phone};let messages=0,saves=0;
    Object.assign(h.c,{B:{upcoming:[job]},esc:s=>s,sendSMS:()=>messages++,confirmMsg:()=> 'Please reply YES',saveB:()=>saves++,renderBoss(){},toast(){}});
    vm.runInContext(part('function openJobConfirmation(','function openSched('),h.c);
    h.c.openJobConfirmation('job1');h.nodes.get('#jc-message').onclick();
    assert.equal(messages,1);assert.equal(job.confirmed,undefined);assert.equal(saves,0);
    h.nodes.get('#jc-close').onclick();assert.equal(job.confirmed,undefined);
    h.c.openJobConfirmation('job1');h.nodes.get('#jc-agreed').onclick();
    assert.equal(job.confirmed,true);assert.equal(saves,1);
  }
});
