import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
const start=source.indexOf('function gearLoading('),end=source.indexOf('const previewGearBtn=',start);
assert.ok(start>0&&end>start);
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const business=(id,extra={})=>({id,slug:id,kid:id,business:id+' Crew',brand:{businessName:id+' Crew',kidName:id,font:'bungee',accent:'#245B45',theme:'neighbor',tagline:'Ready to help'},completedJobs:3,operator:{earned:true},milestoneEmails:false,...extra});
function device(){
  const launched=[],messages=[],requests=[];
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{onclick:null,appendChild(){}});return elements.get(id);};
  const c=vm.createContext({gearOpenId:0,privateViewEpoch:0,gearHandle:null,pendingGearRequest:null,modalDismiss:null,
    FONT_META:{workwear:{},bungee:{},anton:{}},FONT_CSS:'',URLSearchParams,Error,
    privateViewKey:()=>String(c.privateViewEpoch),draftWriteAllowed:()=>true,
    RIGS:{forest:{c:'#245B45'},ember:{c:'#FF5B14'}},
    resolve:()=>({biz:'Device draft',first:'Local',font:'anton',palette:'forest',theme:'clean',tagline:'Local only'}),
    esc:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
    openModal:html=>messages.push(html),closeModal(){},mbody:{querySelector:element},
    document:{createElement:()=>({dataset:{}})},setMode(){},go(){},showAccount:async text=>messages.push(text),toast:text=>messages.push(text),
    pubApi:async(path,options)=>{requests.push({path,options});return {ok:true,selectedBusinessId:path.includes('quinn')?'quinn':'riley',businesses:[business('riley'),business('quinn',{completedJobs:1,operator:{earned:false}})]};}
  });
  vm.runInContext(source.slice(start,end),c);
  c.launchGearStudio=async props=>{launched.push(props);return true;};
  return {c,launched,messages,requests,element};
}

test('saved gear selects the requested child without changing or borrowing the current builder draft',async()=>{
  const h=device();await h.c.openBusinessGear({slug:'quinn'});
  assert.equal(h.launched.length,1);
  const gear=h.launched[0];assert.equal(gear.businessName,'quinn Crew');assert.equal(gear.completedJobs,1);assert.equal(gear.operatorUnlocked,false);
  assert.equal(gear.font,'bungee');assert.equal(gear.canManagePreference,true);assert.equal(gear.canShop,true);
  assert.equal(h.c.resolve().biz,'Device draft');assert.equal(h.requests[0].path,'/api/gear?slug=quinn');
});

test('a gear link for an unavailable business never falls through to a sibling',async()=>{
  const h=device();await h.c.openBusinessGear({businessId:'different-family'});
  assert.equal(h.launched.length,0);assert.match(h.messages.at(-1),/not available in this parent account/);
});

test('a former slug opens the same durable business selected by the server after rename',async()=>{
  const h=device();h.c.pubApi=async()=>({ok:true,selectedBusinessId:'riley',businesses:[business('riley',{slug:'riley-new-address'}),business('quinn')]});
  await h.c.openBusinessGear({slug:'riley-former-address'});assert.equal(h.launched.length,1);assert.equal(h.launched[0].businessName,'riley Crew');
});

test('a saved gear response arriving after sign-out cannot open private designs',async()=>{
  const h=device(),response=deferred();h.c.pubApi=()=>response.promise;
  const pending=h.c.openBusinessGear({businessId:'riley'});
  h.c.privateViewEpoch++;h.c.gearOpenId++;
  response.resolve({ok:true,businesses:[business('riley')]});await pending;
  assert.equal(h.launched.length,0);
});

test('cancelling a gear load prevents its delayed response from reopening the dialog',async()=>{
  const h=device(),response=deferred();h.c.pubApi=()=>response.promise;
  const pending=h.c.openBusinessGear({businessId:'riley'});
  h.c.modalDismiss();response.resolve({ok:true,businesses:[business('riley')]});await pending;
  assert.equal(h.launched.length,0);assert.equal(h.c.pendingGearRequest,null);
});

test('gear email preference writes are per business and stale sessions cannot report success',async()=>{
  const h=device();await h.c.openBusinessGear({businessId:'quinn'});
  const save=h.launched[0].onPreferenceChange;
  let captured;
  h.c.pubApi=async(path,options)=>{captured={path,options};return {ok:true,businesses:[business('quinn',{milestoneEmails:true})]};};
  await save(true);assert.equal(captured.path,'/api/gear');assert.equal(captured.options.body.businessId,'quinn');assert.equal(captured.options.body.milestoneEmails,true);
  const response=deferred();h.c.pubApi=()=>response.promise;
  const pending=save(false);h.c.privateViewEpoch++;
  response.resolve({ok:true,businesses:[business('quinn',{milestoneEmails:false})]});
  await assert.rejects(pending,/session changed/);
  await assert.rejects(save(true),/session changed/);
});

test('parent sign-in preserves the business from an email gear link',async()=>{
  const h=device();h.c.pubApi=async()=>({ok:false,httpStatus:401,error:'auth'});
  await h.c.openBusinessGear({businessId:'quinn'});
  assert.equal(h.c.pendingGearRequest.businessId,'quinn');assert.equal(h.launched.length,0);assert.match(h.messages.at(-1),/Sign in with the parent email/);
});

test('device draft preview gives free designs without parent preferences, shopping, or a local milestone claim',async()=>{
  const h=device();await h.c.openDraftGear();
  assert.equal(h.requests.length,0);assert.equal(h.launched.length,1);
  const gear=h.launched[0];assert.equal(gear.businessName,'Device draft');assert.equal(gear.font,'anton');assert.equal(gear.previewOnly,true);
  assert.equal(gear.canManagePreference,false);assert.equal(gear.canShop,false);assert.equal(gear.operatorUnlocked,false);
});
