import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {extractBuilderParts, demoCfg} from './site-fixture.mjs';
const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
const {genSite}=extractBuilderParts(source);

test('hosted customer pages offer one submit action and describe an unconfirmed request',()=>{
  for(const type of ['lawn','snow','both','prep','pet','odd','wash','help','tutor','other']){
    const html=genSite(demoCfg({type,services:[{n:'Example service',p:'12'}]}));
    const body=html.slice(html.indexOf('<body>'),html.indexOf('<script>window.__C='));
    assert.equal((body.match(/id="sendHost"/g)||[]).length,1,type);
    assert.doesNotMatch(body,/id="sendMail"|Email it instead|>Email</,type);
    assert.match(body,/Nothing is booked until they confirm/,type);
    assert.match(body,/>Request a job</,type);
  }
});
test('customer instructions match the service rather than assuming snow or a yard',()=>{
  for(const type of ['pet','wash','tutor','help']){
    const html=genSite(demoCfg({type,services:[{n:'Example service',p:'12'}]}));
    const body=html.slice(html.indexOf('<body>'),html.indexOf('<script>window.__C='));
    assert.doesNotMatch(body,/where to put the snow|overgrown jobs|when you pull in/,type);
    if(['tutor','help'].includes(type))assert.doesNotMatch(body,/id="sz"/,type);
  }
});
test('review action copies locally without sending to a generic inbox',()=>{
  const nodes={rvErr:{textContent:''},rvName:{value:'Casey'},rvText:{value:'Careful work'},rvStars:{value:'5'},rvOut:{value:''},rvOutWrap:{hidden:true},sendRvMail:{}};
  let copied='';
  const c=vm.createContext({C:{biz:'Taylor’s Pet Care'},$:id=>nodes[id],copyPlain:text=>{copied=text;}});
  const start=source.indexOf('  function rvBuild(){'),end=source.indexOf('  var dock=',start);
  vm.runInContext(source.slice(start,end),c);
  nodes.sendRvMail.onclick();
  assert.match(copied,/Casey/);assert.match(copied,/Careful work/);
  assert.equal(nodes.rvOutWrap.hidden,false);
  copied='';nodes.rvName.value='';nodes.sendRvMail.onclick();
  assert.equal(copied,'');assert.match(nodes.rvErr.textContent,/first name/);
});
