import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {extractBuilderParts,demoCfg} from './site-fixture.mjs';

const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
const {normalizeBrandStyle,siteTheme,SITE_THEMES,genSite}=extractBuilderParts(source);
const types=['pet','prep','lawn','snow','both','odd','wash','help','tutor','other'];

test('legacy empty themes and the Energy alias use red and charcoal without losing business data',()=>{
  for(const theme of [undefined,'','energy']){
    const saved={theme,type:'pet',first:'Alex',palette:'teal',look:'day',services:[{n:'Dog walk',p:'19'}],proof:[{a:'data:image/png;base64,TEST',cap:'Our work'}],reviews:[{n:'Casey',q:'On time'}],flyerStyle:'ink',studio:{layout:3,rig:'teal',bg:'light'}};
    const result=normalizeBrandStyle(structuredClone(saved));
    assert.equal(siteTheme(theme),'hustle');assert.equal(SITE_THEMES[result.theme].name,'Energy');
    assert.equal(result.palette,'mower');assert.equal(result.look,'night');
    for(const key of ['type','first','services','proof','reviews','flyerStyle'])assert.deepEqual(result[key],saved[key],key);
    assert.equal(result.studio.layout,3);assert.equal(result.studio.rig,'mower');assert.equal(result.studio.bg,'dark');
  }
});

test('explicit style choices and their custom colors survive normalization',()=>{
  for(const theme of ['hustle','neighbor','bold','clean','paper','sport','friendly','midnight','retro']){
    const saved={theme,palette:'violet',look:'day',siteFont:'pacifico',flyerStyle:'ink'};
    assert.deepEqual(normalizeBrandStyle({...saved}),saved);
  }
  assert.equal(normalizeBrandStyle({theme:'hustle',palette:'missing'}).palette,'mower');
  assert.equal(normalizeBrandStyle({theme:'neighbor',palette:'missing'}).palette,'forest');
});

test('pet layouts inherit their selected colors and every job keeps the full booking form',()=>{
  for(const theme of ['hustle','neighbor'])for(const type of types){
    const html=genSite(demoCfg({theme,type,palette:theme==='hustle'?'mower':'forest'}));
    assert.ok(html.includes('data-theme="'+theme+'"'));
    assert.ok(html.includes('--bg:'+(theme==='hustle'?'#20262C':'#FBF8F2')));
    assert.ok(html.includes('--accent:'+(theme==='hustle'?'#D94B3D':'#245B45')));
    assert.ok(!html.includes('background:#e7f6ea'));
    if(type==='pet')assert.ok(html.includes('.petbar{background:var(--bg)'));
    for(const id of ['cal','svc','nm','sendHost'])assert.ok(html.includes('id="'+id+'"'),type+' '+id);
  }
});

test('color flyers keep the chosen scheme for pet care and all other jobs',()=>{
  const code=source.slice(source.indexOf('function flyerTheme('),source.indexOf('\nfunction drawHeadline('));
  const ctx=vm.createContext({});vm.runInContext(code,ctx);
  for(const type of types)for(const theme of ['hustle','neighbor']){
    const accent=theme==='hustle'?'#D94B3D':'#245B45';
    const c=ctx.flyerTheme({type,theme,accent,style:'bold'});
    assert.equal(c.bg,theme==='hustle'?'#20262C':'#FBF8F2');
    assert.equal(c.acc,accent);assert.equal(c.paw,'');
    const ink=ctx.flyerTheme({type,theme,accent,style:'ink'});
    assert.equal(ink.bg,'#FFFFFF');assert.equal(ink.acc,'#111111');
  }
});
