import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {extractBuilderParts,demoCfg} from './site-fixture.mjs';

const src=await readFile(new URL('../index.html',import.meta.url),'utf8');
const {genSite}=extractBuilderParts(src);
test('reading and helper requests ask meaningful questions without yard-size or snow copy',()=>{
  for(const type of ['tutor','help','other']){
    const html=genSite(demoCfg({type}));
    assert.doesNotMatch(html,/id="sz"/);
    assert.doesNotMatch(html,/overgrown jobs|where to put the snow|How big is the reader|How big is the family/);
    assert.match(html,/A parent confirms the final price before work starts/);
  }
});
test('hosted booking has one send action and contact labels match their destination',()=>{
  const html=genSite(demoCfg());
  assert.match(html,/id="sendHost"/);
  assert.doesNotMatch(html,/<button[^>]*id="sendMail"/);
  assert.match(html,/href="#book">Open request form/);
  const downloaded=genSite(demoCfg({publish:null}));
  assert.doesNotMatch(downloaded,/<button[^>]*id="sendMail"/);
  assert.match(downloaded,/This is a draft preview/);
});
test('fall yard cleanup omits snowfall recurrence and snow removal retains it',()=>{
  assert.doesNotMatch(genSite(demoCfg({type:'prep'})),/<option>Every snowfall this winter<\/option>/);
  assert.match(genSite(demoCfg({type:'snow'})),/<option>Every snowfall this winter<\/option>/);
});
function pricing(){
  const context=vm.createContext({S:{lvlApplied:1,services:[]}});
  vm.runInContext(src.slice(src.indexOf('const PRESETS='),src.indexOf('function chosenTypes('))+
    src.slice(src.indexOf('const LEVELS='),src.indexOf('function renderLevel('))+
    src.slice(src.indexOf('const LEVEL_CURVE='),src.indexOf('function markTouched('))+
    '\nglobalThis.catalog=PRESETS;',context);
  return context;
}
test('every starter-price curve rises moderately and reverses exactly across all five levels',()=>{
  const p=pricing();
  for(const [type,rows] of Object.entries(p.catalog))for(const [name,prices] of rows){
    assert.equal(prices.length,5,type+' '+name);
    for(let i=1;i<5;i++)assert.ok(prices[i]>=prices[i-1],name);
    assert.ok(prices[4]<=prices[0]*1.6,name+' rises by more than 60%');
    p.S={lvlApplied:1,services:[{n:name,p:String(prices[0])}]};
    for(let level=2;level<=5;level++){p.applyLevel(level);assert.equal(p.S.services[0].p,String(prices[level-1]),name);}
    p.applyLevel(1);assert.equal(p.S.services[0].p,String(prices[0]),name);
  }
});
test('switching price levels leaves manually entered prices alone',()=>{
  const p=pricing();
  p.S={lvlApplied:1,services:[{n:'Mow a small yard',p:'37',t:1}]};
  for(const level of [5,2,4,1]){p.applyLevel(level);assert.equal(p.S.services[0].p,'37');}
});
