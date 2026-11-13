import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const src=await readFile(new URL('../index.html',import.meta.url),'utf8');
function part(start,end){const a=src.indexOf(start),b=src.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return src.slice(a,b);}
function flyer(phone,showPhone=false){const S={flyerQr:'sms',phone,showPhone,siteUrl:'',flyerPhone:false,flyerFmt:'full',flyerStyle:'ink',palette:'ember',town:'Sample town'};const c=vm.createContext({S,RIGS:{ember:{c:'#ff5b14'}},normUrl:()=>'',resolve:()=>({biz:'Alex’s Yard Crew',first:'Alex',parentName:'Jordan',type:'lawn',services:[],phoneDigits:showPhone?phone:''})});vm.runInContext(part('function flyerCfg(){','function renderFlyer('),c);return {cfg:c.flyerCfg(),S};}
test('text flyer works while the website phone number stays private',()=>{const {cfg,S}=flyer('(402) 555-0123');assert.equal(cfg.ok,true);assert.match(cfg.qrText,/^sms:4025550123\?/);assert.match(cfg.urlText,/Text Jordan/);assert.equal(cfg.showPhone,false);assert.doesNotMatch(cfg.urlText,/402|555|0123/);assert.equal(S.showPhone,false);});
test('text flyer refuses missing or invalid parent numbers with a useful next step',()=>{for(const number of ['', '123', 'hello', '1234567890123456']){const {cfg}=flyer(number);assert.equal(cfg.ok,false,number);assert.equal(cfg.qrText,'');assert.match(cfg.why,/step 5/);}});
test('turning all services off blocks publishing until an offered service exists',()=>{const S={first:'Alex',town:'Sample town',services:[{n:'Mowing',on:false}],sched:[{on:true}]};const c=vm.createContext({S});vm.runInContext(part('function missing(){','function shareText(){'),c);assert.deepEqual(JSON.parse(JSON.stringify(c.missing())),[{t:'at least one service',step:2}]);S.services[0].on=true;assert.equal(c.missing().length,0);});
test('older service rows without an on flag remain offered',()=>{const c=vm.createContext({S:{first:'Alex',town:'Sample town',services:[{n:'Mowing'}],sched:[{on:true}]}});vm.runInContext(part('function missing(){','function shareText(){'),c);assert.equal(c.missing().length,0);});
test('storage quota failure is visible and recovers on the next successful save',()=>{const status={hidden:true,textContent:''};let fail=true;const c=vm.createContext({S:{first:'Alex'},LS:'draft',document:{getElementById:()=>status},localStorage:{setItem(){if(fail)throw Error('quota');}}});vm.runInContext(part('function save(){','function resolve('),c);assert.equal(c.save(),false);assert.equal(status.hidden,false);assert.match(status.textContent,/could not save/);fail=false;assert.equal(c.save(),true);assert.equal(status.hidden,true);});

function inviteHarness(S){
  const els=new Map();const el=id=>{if(!els.has(id))els.set(id,{hidden:false,textContent:'',value:'',open:false});return els.get(id);};
  let verifies=0,applies=0,step=-1;
  const c=vm.createContext({S,$:el,localStorage:{setItem(){}},pubApi:async()=>({ok:true,requiresVerification:true,email:'parent@example.com',first:'Alex',biz:'Alex’s Yard Crew'}),missing:()=>S.complete?[]:[{}],go:n=>{step=n;},pubErr:()=>{},pubSignOut:async()=>{verifies++;},clearPending(){},showPublished(){},applyDraft(){applies++;},initPublish(){throw Error('Must verify independently');}});
  vm.runInContext(part('async function openAsk(token){','const customEl='),c);
  return {c,el,state:()=>({verifies,applies,step})};
}
test('an invitation on another device cannot publish or replace an unrelated local draft',async()=>{const S={first:'Blair',bizName:'Blair’s Helpers',complete:true};const h=inviteHarness(S);await h.c.openAsk('test-token');assert.equal(h.el('#pubBox').hidden,true);assert.match(h.el('#askInviteNotice').textContent,/device where they built it/);assert.match(h.el('#askInviteNotice').textContent,/has not published anything/);assert.equal(S.first,'Blair');assert.deepEqual(h.state(),{verifies:0,applies:0,step:7});});
test('an invitation for the complete local draft still requires independent parent verification',async()=>{const h=inviteHarness({first:'Alex',bizName:'Alex’s Yard Crew',complete:true});await h.c.openAsk('test-token');assert.equal(h.el('#pubEmail').value,'parent@example.com');assert.equal(h.el('#pubReady').hidden,true);assert.match(h.el('#askStatus').textContent,/Verify your parent email/);assert.deepEqual(h.state(),{verifies:1,applies:0,step:7});});
