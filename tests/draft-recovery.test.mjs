import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const src=await readFile(new URL('../index.html',import.meta.url),'utf8');
function part(a,b){const i=src.indexOf(a),j=src.indexOf(b,i+a.length);assert.ok(i>=0&&j>i);return src.slice(i,j);}
function harness({owner='',anonymous=false,offline=false,email='',first='Saved Alex',failArchive=false}={}){
 const data=new Map([['draft',JSON.stringify({first,siteUrl:''})],['boss',JSON.stringify({jobs:[{id:'private-job'}]})]]);
 if(owner)data.set('hb-draft-owner',owner);if(anonymous)data.set('hb-anonymous-draft','1');
 const els=new Map();const el=k=>{if(!els.has(k))els.set(k,{hidden:true,textContent:'',value:''});return els.get(k);};
 const localStorage={getItem:k=>data.get(k)??null,setItem(k,v){if(failArchive&&k.startsWith('hb-private-draft:'))throw Error('quota');data.set(k,String(v));},removeItem:k=>data.delete(k),key:i=>[...data.keys()][i],get length(){return data.size;}};
 const c=vm.createContext({privateViewEpoch:0,LS:'draft',BK:'boss',savedRaw:JSON.parse(data.get('draft')),savedBoss:JSON.parse(data.get('boss')),draftOwner:owner,anonymousDraft:anonymous,sessionEmail:'',draftDirty:false,draftRecoveryBlocked:false,S:{first:'',siteUrl:''},B:{jobs:[]},localStorage,document:{getElementById:el},$:el,
  freshBoss:()=>({jobs:[]}),hydrateDraft:raw=>{c.S={first:'',siteUrl:'',...raw};},paintCurrentBuild(){},flyerUrlForDraft:()=>'',currentDraftCode:()=>'',siteDraftsLoad:()=>({}),legacySiteDraft:()=>'',pubSession:()=>null,
  pubPlans(){},publishOrigin:()=> 'https://test.invalid',pubErr(){},pubApi:async()=>{if(offline)throw Error('offline');return email?{ok:true,email,verified:true}:{ok:false};},pubSaveSession(){},showHosting(){},showParentVerified(){},settleGoLive(){},applyPublishState(){},planHelp:()=>'',showCalendar(){},syncCalUpcoming(){},applySavedVenmo(){}});
 vm.runInContext(part('function draftBelongsTo(', '/* The flyer link'),c);
 vm.runInContext(part('function draftWriteAllowed(){','function resolve('),c);
 vm.runInContext(part('function deviceDraftKeys(){','$("#pubSend").onclick='),c);
 return {c,data,el};
}
for(const offline of [false,true])test(`anonymous pre-signup draft survives ${offline?'offline':'signed-out online'} reload`,async()=>{
 const {c,data}=harness({anonymous:true,offline});await c.initPublish();assert.equal(c.S.first,'Saved Alex');assert.ok(data.has('draft'));assert.equal(c.B.jobs[0].id,'private-job');
});
test('owned draft remains saved and hidden offline; early edits cannot replace it',async()=>{
 const {c,data,el}=harness({owner:'parent@example.com',offline:true});c.S.first='Early edit';assert.equal(c.save(),false);assert.equal(c.draftDirty,false);await c.initPublish();assert.notEqual(c.S.first,'Saved Alex');assert.equal(JSON.parse(data.get('draft')).first,'Saved Alex');assert.match(el('saveState').textContent,/saved family draft.*kept/);assert.equal(el('saveState').hidden,false);
});
test('signed-out owned draft remains saved and hidden, then restores after verified owner sign-in',async()=>{
 const {c,data,el}=harness({owner:'parent@example.com'});await c.initPublish();assert.equal(c.S.first,'');assert.ok(data.has('draft'));c.pubApi=async()=>({ok:true,email:'parent@example.com'});await c.initPublish();assert.equal(c.S.first,'Saved Alex');assert.equal(c.B.jobs[0].id,'private-job');assert.equal(el('saveState').hidden,true);assert.equal(el('saveState').textContent,'');
});
test('another verified parent cannot see prior draft; switching back restores archived owner data',async()=>{
 const {c,data}=harness({owner:'first@example.com',email:'second@example.com'});data.set('hb-builds','[{"code":"private","label":"Private name"}]');await c.initPublish();assert.equal(c.S.first,'');assert.equal(data.has('hb-builds'),false);assert.ok(data.has('hb-private-draft:first@example.com'));
 c.pubApi=async()=>({ok:true,email:'first@example.com'});await c.initPublish();assert.equal(c.S.first,'Saved Alex');assert.ok(data.get('hb-builds').includes('Private name'));assert.equal(data.has('hb-private-draft:first@example.com'),false);
});
test('failed archive never deletes original or allows replacement',async()=>{
 const {c,data}=harness({owner:'first@example.com',email:'second@example.com',failArchive:true});await c.initPublish();assert.ok(data.has('draft'));c.S.first='Other parent';assert.equal(c.save(),false);assert.equal(JSON.parse(data.get('draft')).first,'Saved Alex');
});
test('explicit logout/deletion cleanup removes active draft and all private archives',()=>{
 const {c,data}=harness({anonymous:true});data.set('hb-private-draft:other@example.com','{}');data.set('hb-boss-code','{}');c.clearDeviceDraft();assert.equal(data.size,0);assert.equal(c.anonymousDraft,false);assert.equal(c.savedRaw,null);
});
test('new anonymous save records explicit recoverable ownership; verified save claims it',()=>{
 const {c,data}=harness({anonymous:true});c.S.first='New Alex';assert.equal(c.save(),true);assert.equal(data.get('hb-anonymous-draft'),'1');c.sessionEmail='parent@example.com';assert.equal(c.save(),true);assert.equal(data.has('hb-anonymous-draft'),false);assert.equal(data.get('hb-draft-owner'),'parent@example.com');
});

test('account switch clears already hydrated work before new parent can save',async()=>{
 const {c,data}=harness({owner:'first@example.com',email:'second@example.com'});
 c.sessionEmail='first@example.com';c.S={first:'Private Alex',siteUrl:''};c.B={jobs:[{id:'private'}]};c.draftDirty=true;c.save();
 await c.initPublish();assert.equal(c.S.first,'');assert.equal(c.B.jobs.length,0);assert.equal(c.draftDirty,false);
 c.save();assert.equal(JSON.parse(data.get('draft')).first,'');
 assert.match(data.get('hb-private-draft:first@example.com'),/Private Alex/);
});
test('partial archive restore failure keeps backup and locks writes',async()=>{
 const {c,data}=harness({owner:'first@example.com',email:'second@example.com'});await c.initPublish();
 const original=c.localStorage.setItem;let writes=0;c.localStorage.setItem=(k,v)=>{if(++writes===2)throw Error('quota');original(k,v);};
 c.pubApi=async()=>({ok:true,email:'first@example.com'});await c.initPublish();
 assert.ok(data.has('hb-private-draft:first@example.com'));assert.equal(c.draftWriteAllowed(),false);assert.equal(c.save(),false);assert.equal(c.S.first,'');
 c.localStorage.setItem=original;await c.initPublish();assert.equal(c.S.first,'Saved Alex');assert.equal(c.draftWriteAllowed(),true);
});

test('unknown legacy ownerless data is backed up without being shown before an edit replaces it',async()=>{
 const {c,data}=harness();await c.initPublish();assert.equal(c.S.first,'');c.S.first='New public draft';assert.equal(c.save(),true);
 const key=[...data.keys()].find(k=>k.startsWith('hb-private-draft:legacy:'));assert.ok(key);assert.match(data.get(key),/Saved Alex/);assert.equal(JSON.parse(data.get('draft')).first,'New public draft');
});

for(const owned of [false,true])test(`startup navigation ${owned?'cannot overwrite locked owner work':'saves restored anonymous work, not blank defaults'}`,()=>{
 const data=new Map([['draft',JSON.stringify({first:'OfflineSam',builderStep:1})],...(owned?[['hb-draft-owner','parent@example.com']]:[['hb-anonymous-draft','1']])]);
 const el={hidden:true,textContent:'',value:'',disabled:false};const c=vm.createContext({LS:'draft',defaults:()=>({first:''}),document:{getElementById:()=>el,querySelectorAll:()=>[]},$ :()=>el,localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},step:0,STEPS:8,seg:{querySelectorAll:()=>[],setAttribute(){}},window:{scrollTo(){}},updateLaunch(){}});
 vm.runInContext('function hydrateDraft(raw){S=Object.assign(defaults(),raw||{});}',c);
 vm.runInContext(part('function draftBelongsTo(', '/* The flyer link'),c);
 vm.runInContext(part('let S=defaults();','function resolve('),c);
 vm.runInContext(part('function go(n){','$("#stepJump").onchange='),c);
 vm.runInContext('go(Number.isInteger(S.builderStep)?S.builderStep:0)',c);
 assert.equal(JSON.parse(data.get('draft')).first,'OfflineSam');assert.equal(vm.runInContext('S.first',c),owned?'':'OfflineSam');
});

// A server response started before sign-out may finish afterwards.
test('a late identity check cannot restore signed-out family data',async()=>{
 const {c}=harness({owner:'parent@example.com'});let resolve;c.pubApi=()=>new Promise(done=>resolve=done);
 const pending=c.initPublish();c.privateViewEpoch++;c.sessionEmail='';
 resolve({ok:true,email:'parent@example.com',verified:true});await pending;
 assert.equal(c.sessionEmail,'');assert.equal(c.S.first,'');assert.deepEqual(c.B.jobs,[]);
});

test('opening Go live after sign-out does not block the owner archive from restoring',async()=>{
 const {c,data}=harness({owner:'parent@example.com',email:'parent@example.com'});
 c.sessionEmail='parent@example.com';assert.equal(c.archiveDeviceDraft(),true);
 c.document.querySelectorAll=()=>[];c.seg={querySelectorAll:()=>[],setAttribute(){}};
 c.STEPS=8;c.step=0;c.updateLaunch=()=>{};c.window={scrollTo(){}};
 vm.runInContext(part('function go(n){','$("#stepJump").onchange='),c);c.go(7);
 assert.equal(c.draftDirty,false);assert.equal(data.has('draft'),false);
 await c.initPublish();assert.equal(c.S.first,'Saved Alex');assert.equal(c.B.jobs[0].id,'private-job');
});
