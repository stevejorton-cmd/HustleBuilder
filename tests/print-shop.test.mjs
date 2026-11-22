import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
function part(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,start);return source.slice(a,b);}
function harness(){
  const nodes=new Map(),saved=[],renders=[];let cfg={ok:true,fmt:'full',style:'ink'},markup='',checks=0,allowed=true;
  const el=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',disabled:false,hidden:false,value:'',href:'',classList:{toggle(){}},style:{}});return nodes.get(id);};
  const c=vm.createContext({$:el,encodeURIComponent,Blob,Uint8Array,S:{studio:{layout:0}},LAYOUT_NAMES:['Skyline'],
    allowBusinessExport:async status=>{checks++;if(!allowed)status.textContent='Your trial has ended. Ask a parent to choose a plan.';return allowed;},
    flyerCfg:()=>cfg,pcfg:()=>({...cfg,font:'workwear'}),pageDims:fmt=>({print:!['post','story'].includes(fmt)}),
    openModal:html=>{markup=html;},closeModal(){},
    ensureFonts:async()=>{},ensurePetImages:async()=>{},loadFont:async()=>{},
    renderFlyer:scale=>{renders.push({scale,cfg:{...cfg}});return {width:2550,height:3300};},
    renderPoster:scale=>{renders.push({scale,cfg:{...cfg}});return {width:2550,height:3300};},
    canvasBlob:async()=>new Blob(['jpeg'],{type:'image/jpeg'}),makePDF:()=>new Blob(['%PDF-1.4 test'],{type:'application/pdf'}),
    saveFile:async(file,blob)=>{saved.push({file,blob});return {ok:true,how:'browser'};}
  });
  vm.runInContext(part('async function saveFlyer(kind){','async function printFlyer(){')+part('function printShopMapUrl(place){','function renderFlyerChips(){')+part('async function saveStudio(kind){','async function printStudio(){'),c);
  return {c,el,saved,renders,setCfg:v=>cfg=v,setAllowed:v=>allowed=v,get markup(){return markup;},get checks(){return checks;}};
}
test('shop handoff uses current PDF export and waits for an explicit save click',async()=>{
  const h=harness();await h.c.openPrintShop(false);
  assert.equal(h.checks,1);assert.equal(h.saved.length,0);assert.equal(h.renders.length,0);
  assert.match(h.markup,/PDF is not transferred automatically/);assert.match(h.markup,/does not place an order or make a payment/);
  assert.match(h.markup,/https:\/\/www\.office\.fedex\.com\/default\/copies\.html/);
  assert.match(h.markup,/https:\/\/www\.officedepot\.com\/l\/print-and-copy\/document-printing/);
  assert.match(h.markup,/8\.5 × 11 inches, portrait, one-sided, Actual size or 100%/);
  assert.match(h.markup,/black-and-white printing/);
  h.setCfg({ok:true,fmt:'cards',style:'bold'});await h.el('#shopSavePdf').onclick();
  assert.equal(h.checks,2,'save checks the plan again');assert.equal(h.saved.length,1);
  assert.equal(h.saved[0].file,'business-cards.pdf');assert.equal(h.saved[0].blob.type,'application/pdf');assert.equal(h.renders[0].cfg.fmt,'cards','export uses the current design');
  assert.match(h.el('#shopStatus').textContent,/Saved to your downloads folder/);assert.doesNotMatch(h.el('#shopStatus').textContent,/uploaded|ordered/i);
});
test('shop handoff preserves trial, readiness and printable-format gates',async()=>{
  for(const denied of ['plan','readiness','social']){
    const h=harness();if(denied==='plan')h.setAllowed(false);if(denied==='readiness')h.setCfg({ok:false,fmt:'full',why:'Add your website link.'});if(denied==='social')h.setCfg({ok:true,fmt:'story'});
    await h.c.openPrintShop(false);assert.equal(h.markup,'',denied);assert.equal(h.saved.length,0);
    assert.match(h.el('#fStatus').textContent,denied==='plan'?/trial has ended/:denied==='readiness'?/website link/:/printable flyer format/);
  }
  const h=harness();await h.c.openPrintShop(false);h.setAllowed(false);await h.el('#shopSavePdf').onclick();assert.equal(h.saved.length,0);assert.match(h.el('#shopStatus').textContent,/trial has ended/);assert.equal(h.el('#shopSavePdf').disabled,false);
});
test('nearby search encodes optional location and does not transmit or open anything by itself',async()=>{
  const h=harness();await h.c.openPrintShop(false);
  assert.equal(h.c.printShopMapUrl(''),'https://www.google.com/maps/search/?api=1&query=print%20shops%20near%20me');
  h.el('#shopLocation').value='Lincoln, NE & <68510>\n';h.el('#shopLocation').oninput();
  const url=new URL(h.el('#shopNearby').href);assert.equal(url.origin,'https://www.google.com');assert.equal(url.searchParams.get('query'),'print shops near Lincoln, NE & <68510>');
  assert.match(h.markup,/only when you open that link/);assert.equal(h.saved.length,0);assert.equal(h.renders.length,0);
  assert.doesNotMatch(part('function printShopMapUrl(place){','function renderFlyerChips(){'),/fetch\(|window\.open|geolocation|navigator\.share|FormData/);
});
test('studio handoff exports the poster PDF and reports save failures honestly',async()=>{
  const h=harness();h.setCfg({ok:true,bg:'accent',font:'workwear'});await h.c.openPrintShop(true);assert.match(h.markup,/Choose color printing/);await h.el('#shopSavePdf').onclick();assert.equal(h.saved[0].file,'poster-skyline.pdf');assert.match(h.el('#shopStatus').textContent,/Saved to your downloads folder/);
  h.c.saveFile=async()=>({ok:false,declined:true});await h.el('#shopSavePdf').onclick();assert.match(h.el('#shopStatus').textContent,/No problem/);assert.equal(h.el('#shopSavePdf').disabled,false);
  h.c.saveFile=async()=>{throw Error('save failed');};await h.el('#shopSavePdf').onclick();assert.match(h.el('#shopStatus').textContent,/Could not save the PDF/);assert.equal(h.el('#shopSavePdf').disabled,false);
});
test('shop buttons follow flyer printable formats and both preview readiness states',()=>{
  assert.match(source,/id="fShop" disabled>Print at a shop/);assert.match(source,/id="pShop">Print at a shop/);
  const flyer=part('function drawFlyerPreview(){','let fontsReady=');assert.match(flyer,/\$\("#fShop"\)\.hidden=!pr/);assert.match(flyer,/\["#fPdf","#fPng","#fPrint","#fShop"\]/);
  const studio=part('function drawStudio(){','function stSurprise(');assert.match(studio,/\["#pPdf","#pPng","#pPrint","#pShop"\]/);
});
