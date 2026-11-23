import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../index.html',import.meta.url),'utf8');
function between(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end,from + start.length);
  assert.ok(from >= 0 && to > from,start);
  return source.slice(from,to);
}
const implementations = [
  between('function publishExtras(slug){','function deviceDraftKeys(){'),
  between('async function pubPush(){','async function buyPlanFirst('),
  between('function currentDraftCode(){','function noteCurrentBuild(){'),
  between('async function saveDraftChecked(){','async function stashCurrentBuild(){')
].join('\n');
function deferred() { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise,resolve}; }
function harness(options = {}) {
  const values = new Map([['hb-draft','draft001'],['hb-draft-code','sibling1'],['hb-job-code','sibling2']]);
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id,{value:'',checked:false,hidden:false,disabled:false,readOnly:false,textContent:'',scrollIntoView(){}});
    return els.get(id);
  };
  el('#pubSlug').value = 'alex-lawn'; el('#familyNote').hidden = true; el('#pubConsent').checked = true;
  const state = {
    allowed:true,consent:false,token:'parent-token',session:{email:'parent@example.test',slug:''},
    me:{ok:true,email:'parent@example.test',consent:true,paid:true,slugs:[],slug:''},
    saveCode:'draft001',confirm:true,checkout:true,calls:[],notices:[],published:[],records:[],pending:[],sessionSaves:0,checkoutCalls:0,confirmCalls:0,localSaves:0,...options
  };
  const c = vm.createContext({
    S:{type:'lawn',first:'Alex',town:'Test Town',bizName:'Alex Lawn',tagline:'Clean edges',services:[{n:'Mow',p:'25'}],theme:'neighbor',palette:'forest',siteFont:'anton',siteUrl:'',venmo:''},
    privateViewEpoch:0,sessionEmail:'parent@example.test',draftTimer:0,
    $:el,localStorage:{getItem:key => values.get(key) ?? null,setItem:(key,value) => values.set(key,String(value)),removeItem:key => values.delete(key)},
    location:{href:''},Intl,clearTimeout(){},
    draftWriteAllowed:() => state.allowed,draftRecoveryNotice:() => state.notices.push('Draft is locked'),
    draftPayload:() => JSON.parse(JSON.stringify(c.S)),
    privateViewKey:() => [state.session?.email || '',state.token,values.get('hb-job-code') || ''].join('|'),
    pubSession:() => state.session ? {...state.session} : null,pubToken:() => state.token,
    pubSaveSession:session => {state.sessionSaves++;state.session = {...session};},
    publishOrigin:() => 'https://publish.test',publishedHtml:slug => JSON.stringify({slug,first:c.S.first,business:c.S.bizName,font:c.S.siteFont}),
    autoBiz:(type,first) => first + ' Lawn',typeInfo:() => ({label:'Lawn help'}),RIGS:{ember:{c:'#FF5B14'},forest:{c:'#245B45'}},petList:() => [],
    missing:() => [],updateLaunch(){},priceNum:value => Number(value),priceTooHigh:value => value > 999,
    pubErr:message => state.notices.push(message),rememberExportDeadline(){},
    showHosting:me => {state.consent = !!me.consent;},consentOn:() => state.consent,
    rememberLocalBuild:() => {state.localSaves++;return 'local001';},
    ownedSlugs:me => me.slugs || [],siteDraftsLoad:() => state.siteOwners || {},legacySiteDraft:() => '',
    siteOwnerOf:(owners,slug) => owners[slug] || '',replaceWarnNeeded:(owner,code) => !!(owner && code && owner !== code),
    buildLabelOf:state => state.bizName,esc:value => String(value),
    confirmModal:async () => {state.confirmCalls++;return state.onConfirm ? state.onConfirm() : state.confirm;},
    pubCheckout:async () => {state.checkoutCalls++;return state.onCheckout ? state.onCheckout() : state.checkout;},
    savePending:slug => state.pending.push(slug),clearPending(){},
    recordSiteDraft:slug => state.records.push({slug,code:values.get('hb-draft')}),
    showPublished:url => {state.published.push(url);c.S.siteUrl = url;},settleGoLive(){},
    pubApi:async (path,request = {}) => {
      state.calls.push({path,...JSON.parse(JSON.stringify(request))});
      if (path === '/api/me') return state.onMe ? state.onMe() : {...state.me};
      if (path === '/api/consent') {
        if (state.onConsent) return state.onConsent();
        state.me.consent = true; return {ok:true};
      }
      if (path === '/api/draft') return state.onDraft ? state.onDraft(request.body) : {ok:true,code:state.saveCode};
      if (path === '/api/publish') return state.onPublish ? state.onPublish(request.body) : {ok:true,slug:request.body.slug,url:'https://publish.test/' + request.body.slug,jobCode:request.body.draftCode};
      throw new Error('Unexpected API ' + path);
    }
  });
  vm.runInContext(implementations,c);
  return {c,state,values,el,push:() => c.pubPush(),calls:path => state.calls.filter(call => call.path === path)};
}

test('publishExtras reads only the current draft, never a sibling job code or the old storage key', () => {
  const h = harness();
  assert.equal(h.c.publishExtras('alex-lawn').draftCode,'draft001');
  h.values.delete('hb-draft');
  assert.equal(h.c.publishExtras('alex-lawn').draftCode,'');
  h.values.set('hb-draft','not-a-cloud-code');
  assert.equal(h.c.publishExtras('alex-lawn').draftCode,'');
});

test('first publish saves the exact draft to the cloud before sending its new code and matching design', async () => {
  const h = harness({saveCode:'newcode1'}); h.values.delete('hb-draft');
  await h.push();
  const saved = h.calls('/api/draft')[0], published = h.calls('/api/publish')[0];
  assert.ok(saved); assert.ok(published);
  assert.ok(h.state.calls.indexOf(saved) < h.state.calls.indexOf(published));
  assert.equal(saved.body.code,''); assert.equal(saved.body.draft.siteFont,'anton');
  assert.equal(published.body.draftCode,'newcode1'); assert.equal(published.body.accent,'#245B45');
  assert.equal(JSON.parse(published.body.html).font,saved.body.draft.siteFont);
  assert.equal(JSON.parse(published.body.html).business,saved.body.draft.bizName);
  assert.deepEqual(h.state.records,[{slug:'alex-lawn',code:'newcode1'}]);
  assert.equal(h.state.localSaves,0,'publication requires the cloud branch of saveDraftChecked');
  assert.equal(h.el('#pubGo').disabled,false); assert.equal(h.state.published.length,1);
});

test('a rejected or unavailable draft save prevents publication without borrowing a family code', async () => {
  for (const onDraft of [async () => ({ok:false,error:'auth'}),async () => {throw new Error('offline');},async () => ({ok:true,code:'invalid'})]) {
    const h = harness({onDraft}); await h.push();
    assert.equal(h.calls('/api/publish').length,0); assert.equal(h.state.published.length,0);
    assert.match(h.state.notices.at(-1),/Could not save this draft/); assert.equal(h.el('#pubGo').disabled,false);
  }
});

test('editing the draft or its publish settings during cloud save cannot publish a mismatched snapshot', async () => {
  for (const change of [h => {h.c.S.siteFont = 'pacifico';},h => {h.el('#pubSlug').value = 'sam-pets';},h => {h.el('#pubIndex').checked = true;}]) {
    const entered = deferred(), release = deferred();
    const h = harness({onDraft:async () => {entered.resolve();await release.promise;return {ok:true,code:'draft001'};}});
    const publishing = h.push(); await entered.promise; change(h); release.resolve(); await publishing;
    assert.equal(h.calls('/api/publish').length,0); assert.match(h.state.notices.at(-1),/draft changed/i);
    assert.equal(h.state.records.length,0); assert.equal(h.el('#pubGo').disabled,false);
  }
});

test('switching builds while cloud save is pending keeps the new build selected and does not publish it', async () => {
  const entered = deferred(), release = deferred();
  const h = harness({onDraft:async () => {entered.resolve();await release.promise;return {ok:true,code:'returned'};}});
  const publishing = h.push(); await entered.promise;
  h.values.set('hb-draft','sibling3'); h.c.S.first = 'Sam'; h.c.S.bizName = 'Sam Pets';
  release.resolve(); await publishing;
  assert.equal(h.values.get('hb-draft'),'sibling3'); assert.equal(h.calls('/api/publish').length,0);
  assert.equal(h.state.records.length,0); assert.equal(h.state.published.length,0);
});

test('sign-out or a parent identity change while saving cancels publish and late private UI updates', async () => {
  for (const change of [h => {h.c.privateViewEpoch++;h.state.token = '';},h => {h.state.session = {email:'another@example.test'};h.state.token = 'other-parent';},h => {h.state.allowed = false;}]) {
    const entered = deferred(), release = deferred();
    const h = harness({onDraft:async () => {entered.resolve();await release.promise;return {ok:true,code:'draft001'};}});
    const publishing = h.push(); await entered.promise; change(h); release.resolve(); await publishing;
    assert.equal(h.calls('/api/publish').length,0); assert.equal(h.state.sessionSaves,0); assert.equal(h.state.records.length,0);
  }
});

test('a changed draft or mismatched server parent during initial checks cannot reach cloud save or publish', async () => {
  const entered = deferred(), release = deferred(), h = harness();
  h.state.onMe = async () => {entered.resolve();await release.promise;return {...h.state.me};};
  const publishing = h.push(); await entered.promise; h.c.S.first = 'Different'; release.resolve(); await publishing;
  assert.equal(h.calls('/api/draft').length,0); assert.equal(h.calls('/api/publish').length,0);
  const wrong = harness(); wrong.state.me.email = 'different-parent@example.test'; await wrong.push();
  assert.equal(wrong.calls('/api/draft').length,0); assert.equal(wrong.calls('/api/publish').length,0);
  assert.match(wrong.state.notices.at(-1),/Verify the parent/);
});

test('sibling replacement still requires approval and cancellation publishes nothing', async () => {
  for (const confirm of [false,true]) {
    const h = harness({confirm,siteOwners:{'alex-lawn':'sibling1'}}); h.state.me.slugs = ['alex-lawn'];
    await h.push(); assert.equal(h.state.confirmCalls,1);
    assert.equal(h.calls('/api/publish').length,confirm ? 1 : 0);
    if (!confirm) assert.equal(h.state.notices.at(-1),'Nothing was published.');
  }
  const same = harness({siteOwners:{'alex-lawn':'draft001'}}); same.state.me.slugs = ['alex-lawn']; await same.push();
  assert.equal(same.state.confirmCalls,0); assert.equal(same.calls('/api/publish').length,1);
});

test('changing the selected build during a replacement approval stops the approved old snapshot', async () => {
  const entered = deferred(), release = deferred();
  const h = harness({siteOwners:{'alex-lawn':'sibling1'},onConfirm:async () => {entered.resolve();await release.promise;return true;}});
  h.state.me.slugs = ['alex-lawn'];
  const publishing = h.push(); await entered.promise; h.values.set('hb-draft','sibling3'); release.resolve(); await publishing;
  assert.equal(h.calls('/api/publish').length,0); assert.equal(h.state.records.length,0);
});

test('payment gating is preserved for a new expired-plan page and skips an already owned page', async () => {
  const paid = harness(); Object.assign(paid.state.me,{paid:false,grace:false,trialOver:true}); await paid.push();
  assert.equal(paid.state.checkoutCalls,1); assert.equal(paid.calls('/api/publish').length,1);
  const redirect = harness({checkout:false}); Object.assign(redirect.state.me,{paid:false,grace:false,trialOver:true}); await redirect.push();
  assert.equal(redirect.state.checkoutCalls,1); assert.equal(redirect.calls('/api/publish').length,0);
  const owned = harness({siteOwners:{'alex-lawn':'draft001'}}); Object.assign(owned.state.me,{paid:false,grace:false,trialOver:true,slugs:['alex-lawn']}); await owned.push();
  assert.equal(owned.state.checkoutCalls,0); assert.equal(owned.calls('/api/publish').length,1);
});

test('draft changes during payment prevent publishing different content after payment returns', async () => {
  const entered = deferred(), release = deferred();
  const h = harness({onCheckout:async () => {entered.resolve();await release.promise;return true;}});
  Object.assign(h.state.me,{paid:false,grace:false,trialOver:true});
  const publishing = h.push(); await entered.promise; h.c.S.siteFont = 'pacifico'; release.resolve(); await publishing;
  assert.equal(h.calls('/api/publish').length,0); assert.match(h.state.notices.at(-1),/draft changed/i);
});

test('parent-verification redirects retain the pending slug and do not save or publish prematurely', async () => {
  const h = harness({onConsent:async () => ({ok:true,url:'https://checkout.test/verify'})}); h.state.me.consent = false;
  await h.push();
  assert.deepEqual(h.state.pending,['alex-lawn']); assert.equal(h.c.location.href,'https://checkout.test/verify');
  assert.equal(h.calls('/api/draft').length,0); assert.equal(h.calls('/api/publish').length,0);
});

test('sign-out during the submitted publish prevents a late response from restoring the parent or changing the current build', async () => {
  const entered = deferred(), release = deferred();
  const h = harness({onPublish:async body => {entered.resolve();await release.promise;return {ok:true,slug:body.slug,url:'https://publish.test/' + body.slug,jobCode:'draft001'};}});
  const publishing = h.push(); await entered.promise; h.c.privateViewEpoch++; h.state.token = ''; release.resolve(); await publishing;
  assert.equal(h.calls('/api/publish').length,1); assert.equal(h.state.sessionSaves,0); assert.equal(h.state.records.length,0); assert.equal(h.state.published.length,0);
});

test('a changed draft during the submitted publish stays separate from its response and receives an accurate status', async () => {
  const entered = deferred(), release = deferred();
  const h = harness({onPublish:async body => {entered.resolve();await release.promise;return {ok:true,slug:body.slug,url:'https://publish.test/' + body.slug};}});
  const publishing = h.push(); await entered.promise; h.c.S.bizName = 'A new draft name'; release.resolve(); await publishing;
  assert.equal(h.calls('/api/publish').length,1); assert.equal(h.state.records.length,0); assert.equal(h.state.published.length,0);
  assert.match(h.state.notices.at(-1),/Refresh your account to check/);
  assert.doesNotMatch(h.state.notices.at(-1),/Nothing was published/);
});
