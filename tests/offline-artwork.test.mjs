import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,stat} from 'node:fs/promises';
const source=await readFile(new URL('../sw.js',import.meta.url),'utf8');
const origin='https://hustlebuilder.org';
function response(body='photo',type='image/webp',status=200){return {body,ok:status===200,type:'basic',status,headers:{get:()=>type},clone(){return response(body,type,status);}};}
function harness(){
 const handlers={},stores=new Map();let offline=false,badImage='';
 const key=x=>typeof x==='string'?x:new URL(x.url).pathname;
 const caches={async open(name){if(!stores.has(name))stores.set(name,new Map());const data=stores.get(name);return {async addAll(paths){for(const p of paths)data.set(p,response('shell','text/html'));},async put(path,res){data.set(key(path),res);},async match(path){return data.get(key(path));}};},async keys(){return [...stores.keys()];},async delete(name){return stores.delete(name);}};
 const context=vm.createContext({URL,Set,Request:class{constructor(path){this.url=new URL(path,origin).href;}},Response:{error:()=>response('network error','',0)},caches,fetch:async req=>{if(offline)throw Error('offline');return key(req)===badImage?response('sign-in page','text/html'):response();},self:{location:{origin},addEventListener:(name,fn)=>handlers[name]=fn,skipWaiting(){},clients:{async claim(){}}}});
 vm.runInContext(source,context);
 async function dispatch(name,request){const work=[];let result;handlers[name]({request,waitUntil:p=>work.push(p),respondWith:p=>result=p});const res=await result;await Promise.all(work);return res;}
 return {context,stores,caches,dispatch,setOffline:v=>offline=v,setBad:p=>badImage=p};
}
test('installed artwork survives a network failure, including old and refreshed photo URLs',async()=>{
 const h=harness();await h.dispatch('install');h.setOffline(true);
 for(const path of ['/assets/refresh/prep.webp','/assets/hustle/prep.webp','/assets/jobs/prep.webp','/assets/scenes/dusk-lawn.jpg','/assets/pets/pet-hero.webp']){
  const r=await h.dispatch('fetch',{url:origin+path,method:'GET'});assert.equal(r.body,'photo',path);
 }
 const shell=await h.dispatch('fetch',{url:origin+'/?account=1',method:'GET'});assert.equal(shell.body,'shell');
});
test('invalid image responses cannot replace a good offline photo',async()=>{
 const h=harness();await h.dispatch('install');h.setBad('/assets/refresh/prep.webp');
 const r=await h.dispatch('fetch',{url:origin+'/assets/refresh/prep.webp',method:'GET'});assert.equal(r.body,'photo');
 h.setOffline(true);assert.equal((await h.dispatch('fetch',{url:origin+'/assets/refresh/prep.webp',method:'GET'})).body,'photo');
});
test('one failed optional photo does not stop installation and can recover on a later request',async()=>{
 const h=harness();h.setBad('/assets/refresh/prep.webp');await h.dispatch('install');h.setBad('');
 await h.dispatch('fetch',{url:origin+'/assets/refresh/prep.webp',method:'GET'});h.setOffline(true);
 assert.equal((await h.dispatch('fetch',{url:origin+'/assets/refresh/prep.webp',method:'GET'})).body,'photo');
});
test('private APIs, uploaded photos, cross-origin URLs, and writes bypass the artwork cache',async()=>{
 const h=harness();await h.dispatch('install');h.setOffline(true);
 for(const request of [{url:origin+'/api/account',method:'GET'},{url:origin+'/uploads/private.webp',method:'GET'},{url:'https://other.test/assets/refresh/prep.webp',method:'GET'},{url:origin+'/assets/refresh/prep.webp',method:'POST'}])assert.equal(await h.dispatch('fetch',request),undefined);
});
test('cache upgrade removes only old app caches and every precached photo exists',async()=>{
 const h=harness();await h.caches.open('hustle-shell-4');await h.caches.open('unrelated-cache');await h.dispatch('install');await h.dispatch('activate');
 assert.deepEqual(await h.caches.keys(),['unrelated-cache','hustle-shell-5']);
 for(const path of vm.runInContext('ARTWORK',h.context))assert.ok((await stat(new URL('..'+path,import.meta.url))).isFile(),path);
});
