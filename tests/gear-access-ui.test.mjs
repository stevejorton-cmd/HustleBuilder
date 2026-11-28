import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
const start=source.indexOf('function gearKidKey('),end=source.indexOf('const previewGearBtn=',start);
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

function verificationDevice({search='?gear=1&business=quinn',pending={businessId:'quinn'}}={}){
  const h=device(),events=[];
  for(const id of ['#pubVerify','#pubCode','#pubEmail','#pubVerified','#pubIndex'])Object.assign(h.element(id),{disabled:false,value:'',checked:false,scrollIntoView(){}});
  h.element('#pubCode').value='123456';h.element('#pubEmail').value='parent@example.test';
  const originalApi=h.c.pubApi;
  Object.assign(h.c,{
    $:h.element,pubMemToken:'',sessionEmail:'',draftDirty:true,location:{search},pendingGearRequest:pending,
    pubErr:text=>h.messages.push(text),pubSaveSession(){},forgetUnownedDraft:()=>true,restoreArchivedDraft:()=>true,
    restoreOwnedDraft(){},save(){},showParentVerified(){},applyPublishState(){},showHosting(){},showCalendar(){},syncCalUpcoming(){},
    showAccount:async()=>{events.push('account');},
    pubApi:async(path,options)=>{
      if(path==='/api/auth/verify')return {ok:true,token:'verified-parent-token',email:'parent@example.test',slug:'riley'};
      if(path==='/api/me')return {ok:true,email:'parent@example.test',consent:true};
      events.push('gear');return originalApi(path,options);
    }
  });
  const a=source.indexOf('$("#pubVerify").onclick=async()=>{'),b=source.indexOf('async function pollPaid(',a);
  assert.ok(a>0&&b>a);vm.runInContext(source.slice(a,b),h.c);
  return {...h,events,verify:()=>h.element('#pubVerify').onclick()};
}

for(const search of ['?gear=1&business=quinn',''])test(`parent verification refreshes account before opening the pending child gear ${search?'from an email':'from an account action'}`,async()=>{
  const h=verificationDevice({search}),ready=deferred(),entered=deferred();
  h.c.showAccount=async()=>{h.events.push('account-start');entered.resolve();await ready.promise;h.events.push('account-ready');};
  const verifying=h.verify();await entered.promise;
  assert.equal(h.launched.length,0,'gear must wait for the signed-in account cards');
  assert.equal(h.c.pendingGearRequest.businessId,'quinn');
  ready.resolve();await verifying;await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.events,['account-start','account-ready','gear']);
  assert.equal(h.launched.length,1);assert.equal(h.launched[0].businessName,'quinn Crew');
  assert.equal(h.c.resolve().biz,'Device draft','opening saved gear never changes the local draft');
  assert.equal(h.element('#pubVerify').disabled,false);
});

test('sign-out or family switch during the post-verification account refresh cannot reopen private gear',async()=>{
  const h=verificationDevice(),ready=deferred(),entered=deferred();
  h.c.showAccount=async()=>{entered.resolve();await ready.promise;};
  const verifying=h.verify();await entered.promise;
  h.c.privateViewEpoch++;h.c.gearOpenId++;h.c.pubMemToken='';h.c.sessionEmail='';
  ready.resolve();await verifying;
  assert.equal(h.launched.length,0);assert.equal(h.requests.length,0);
});

test('a cancelled pending gear request is not restored when the account refresh finishes',async()=>{
  const h=verificationDevice(),ready=deferred(),entered=deferred();
  h.c.showAccount=async()=>{entered.resolve();await ready.promise;};
  const verifying=h.verify();await entered.promise;h.c.pendingGearRequest=null;
  ready.resolve();await verifying;
  assert.equal(h.launched.length,0);assert.equal(h.requests.length,0);
});

test('account links still refresh after verification without opening gear',async()=>{
  const h=verificationDevice({search:'?account=1',pending:null});await h.verify();
  assert.deepEqual(h.events,['account']);assert.equal(h.launched.length,0);
});

test('ordinary publishing verification does not add an unrelated account or gear load',async()=>{
  const h=verificationDevice({search:'',pending:null});await h.verify();
  assert.deepEqual(h.events,[]);assert.equal(h.launched.length,0);
});

test('the booking gear entry does not list every child when no page is open',async()=>{
  const h=device();await h.c.openBusinessGear();
  assert.equal(h.launched.length,0);
  assert.match(h.messages.at(-1),/own page/);
  assert.doesNotMatch(h.messages.at(-1),/Whose business gear|riley|quinn/i);
});

test('a kid with two businesses is listed alone, and a sibling id is refused',async()=>{
  const h=device(),labels=[];
  h.c.pubApi=async(path)=>{
    if(String(path).includes('businessId=quinn')&&String(path).includes('kid=Riley'))return {ok:false,status:404,error:'business',message:'That business is not available in this parent account.'};
    return {ok:true,selectedBusinessId:'',businesses:[business('riley',{kid:'Riley',business:'Riley Yard'}),business('riley-snow',{id:'riley-snow',kid:'Riley',business:'Riley Snow'}),business('quinn',{kid:'Quinn',business:'Quinn Pets'})]};
  };
  h.c.document.createElement=()=>{const el={dataset:{},className:'',onclick:null};let text='';Object.defineProperty(el,'textContent',{get(){return text;},set(v){text=String(v);labels.push(text);}});return el;};
  await h.c.openBusinessGear({kid:'Riley'});
  assert.equal(h.launched.length,0);
  assert.match(h.messages.at(-1),/Whose business gear/);
  assert.doesNotMatch(h.messages.at(-1),/Quinn/);
  assert.deepEqual(labels.filter(Boolean),['Riley · Riley Yard','Riley · Riley Snow']);
  await h.c.openBusinessGear({businessId:'quinn',kid:'Riley'});
  assert.equal(h.launched.length,0);
  assert.match(h.messages.at(-1),/not available in this parent account/);
  assert.doesNotMatch(h.messages.at(-1),/Quinn Pets|Riley Yard/);
});

test('a page slug still opens that business when a sibling is present in a bad payload',async()=>{
  const h=device();await h.c.openBusinessGear({slug:'quinn'});
  assert.equal(h.launched.length,1);assert.equal(h.launched[0].businessName,'quinn Crew');
});
