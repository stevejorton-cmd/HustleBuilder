import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const previewArtCache='),source.indexOf('\ndocument.querySelectorAll("[data-k]")'));
function setup(fetch){
  const frame={srcdoc:''};
  class Reader { readAsDataURL(){this.result='data:image/webp;base64,TEST';this.onload();} }
  const context=vm.createContext({URL,location:{href:'https://preview.test/',origin:'https://preview.test'},fetch,FileReader:Reader,frame,resolve:()=>({}),genSite:()=>'<img src="/assets/hustle/snow.webp"><a href="/assets/hustle/snow.webp">image</a>'});
  vm.runInContext(code,context);
  return {context,frame};
}
test('sandbox preview embeds same-origin artwork once and keeps non-image links intact',async()=>{
  let calls=0;
  const {context,frame}=setup(async(url,options)=>{
    calls++;assert.equal(url,'https://preview.test/assets/hustle/snow.webp');
    assert.equal(options.credentials,'same-origin');
    return {ok:true,headers:{get:()=> 'image/webp'},blob:async()=>({})};
  });
  await context.refresh();await context.refresh();
  assert.equal(calls,1);
  assert.match(frame.srcdoc,/<img src="data:image\/webp;base64,TEST">/);
  assert.match(frame.srcdoc,/<a href="\/assets\/hustle\/snow.webp">/);
});
test('preview never fetches external images or private endpoint URLs',async()=>{
  const {context}=setup(()=>{throw Error('must not fetch');});
  for(const src of ['https://external.test/pic.webp','/api/book/pic.webp','data:image/png;base64,AA'])assert.equal(await context.previewArtData(src),src);
});
test('failed preview images leave the website usable and retry on the next refresh',async()=>{
  let calls=0;const {context,frame}=setup(async()=>{calls++;return {ok:false};});
  await context.refresh();await context.refresh();
  assert.equal(calls,2);assert.match(frame.srcdoc,/<img src="\/assets\/hustle\/snow.webp">/);
});
test('an older artwork response cannot replace a newer website preview',async()=>{
  let release;
  const {context,frame}=setup(()=>new Promise(done=>{release=()=>done({ok:false});}));
  const old=context.refresh();
  context.genSite=()=>'<h1>New business</h1>';
  await context.refresh();release();await old;
  assert.equal(frame.srcdoc,'<h1>New business</h1>');
});

test('refreshed welcome and pet images also embed in protected previews',async()=>{
  let calls=0;const {context}=setup(async()=>{calls++;return {ok:true,headers:{get:()=> 'image/webp'},blob:async()=>({})};});
  for(const src of ['/assets/refresh/prep.webp','/assets/refresh/pet.webp'])assert.match(await context.previewArtData(src),/^data:image/);
  assert.equal(calls,2);
});
