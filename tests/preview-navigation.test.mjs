import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {extractBuilderParts, demoCfg} from './site-fixture.mjs';

const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('const previewArtCache='), source.indexOf('\ndocument.querySelectorAll("[data-k]")'));
const sample = `<!DOCTYPE html><html><head><title>Preview</title></head><body>
<a class="btn" id="heroCta" href="#book">Request a job</a>
<a href="#rates">Rates</a>
<a href="/privacy">Privacy</a>
<a href="https://venmo.com/taylor" target="_blank" rel="noopener">Pay with Venmo</a>
<a href="https://hustlebuilder.org/#book" target="_top">Open outside</a>
<section id="book"><h2>Request a job</h2><p class="small">This is a draft preview. A parent publishes the website at Go live to enable booking requests.</p></section>
<section id="rates">Rates</section>
<button type="button" class="day">12</button>
<form onsubmit="return false"><button type="button" class="btn" id="sendHost">Send my request</button></form>
<p class="err" id="err"></p>
</body></html>`;

function setup(genSite){
  const loads = [];
  const frame = {
    srcdoc: '',
    addEventListener(type, fn){
      assert.equal(type, 'load');
      loads.push(fn);
    }
  };
  const context = vm.createContext({
    URL,
    location: {href: 'https://hustlebuilder.org/', origin: 'https://hustlebuilder.org'},
    fetch: async () => { throw new Error('preview navigation test must not fetch'); },
    FileReader: class {},
    frame,
    resolve: () => ({}),
    genSite
  });
  vm.runInContext(code, context);
  return {context, frame, loads};
}

function node(tag, props = {}){
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: props.id || '',
    className: props.className || '',
    attrs: {...(props.attrs || {})},
    parentNode: props.parent || null,
    parentElement: props.parent || null,
    textContent: props.text || '',
    scrolled: null,
    boxTop: props.top == null ? 640 : props.top,
    removed: false,
    replaced: null,
    classList: null,
    getAttribute(name){ return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    closest(sel){
      const parts = String(sel).split(',').map(s => s.trim());
      let cur = this;
      while (cur) {
        if (parts.some(part => {
          if (part === 'a') return cur.tagName === 'A';
          if (part.startsWith('#')) return cur.id === part.slice(1);
          if (part.startsWith('.')) return cur.className.split(/\s+/).includes(part.slice(1));
          return false;
        })) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    getBoundingClientRect(){ return {top: this.boxTop, left: 0, width: 100, height: 80}; },
    scrollIntoView(opt){ this.scrolled = opt || {}; },
    replaceChild(next, prev){
      this.replaced = next;
      prev.removed = true;
      prev.parentNode = null;
      prev.parentElement = null;
      next.parentNode = this;
      next.parentElement = this;
    }
  };
  el.classList = {contains: name => el.className.split(/\s+/).includes(name)};
  return el;
}

function runGuard(script, {readyState = 'complete', elements = []} = {}){
  const byId = new Map(elements.filter(el => el.id).map(el => [el.id, el]));
  const listeners = {};
  const scrolls = [];
  const window = {pageYOffset: 0, scrollTo(opt){ scrolls.push(opt); }};
  const document = {
    readyState,
    addEventListener(type, fn){ (listeners[type] ||= []).push(fn); },
    getElementById(id){ const el = byId.get(id); return el && !el.removed ? el : null; },
    createElement(tag){ return node(tag); }
  };
  vm.runInContext(script, vm.createContext({document, decodeURIComponent, window}));
  function emit(type, target){
    const event = {
      target,
      defaultPrevented: false,
      stopped: false,
      preventDefault(){ this.defaultPrevented = true; },
      stopImmediatePropagation(){ this.stopped = true; }
    };
    let onclick = null;
    for (const fn of listeners[type] || []) {
      fn(event);
      if (event.stopped) break;
    }
    if (!event.stopped && type === 'click' && target && target.onclick) onclick = target.onclick();
    return {event, onclick};
  }
  return {listeners, emit, byId, scrolls};
}

function same(actual, expected, message){
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}
test('in-preview hash links scroll and every other navigation stays in the frame', () => {
  const {context} = setup(() => '<p>unused</p>');
  same(context.previewLinkAction('#book'), {type: 'scroll', id: 'book'});
  same(context.previewLinkAction('  #rates  '), {type: 'scroll', id: 'rates'});
  same(context.previewLinkAction('#work%20photos'), {type: 'scroll', id: 'work photos'});
  for (const href of ['/privacy', '/security', 'https://venmo.com/taylor', 'https://hustlebuilder.org/#book', 'sms:14025550100', '', '#', 'book']) {
    same(context.previewLinkAction(href), {type: 'stay'}, href);
  }
  for (const target of ['_blank', '_top', '_parent', ' _top ']) {
    same(context.previewLinkAction('#book', target), {type: 'stay'}, target);
  }
});

test('phone preview keeps Request a job inside the frame and restores a navigated frame', async () => {
  const {context, frame, loads} = setup(() => sample);
  await context.refresh();
  assert.equal(loads.length, 1);
  assert.match(frame.srcdoc, /<!-- hb-preview-nav --><script>/);
  assert.equal(frame.srcdoc.split('hb-preview-nav').length - 1, 1);
  assert.match(frame.srcdoc, /href="#book">Request a job/);
  assert.match(frame.srcdoc, /This is a draft preview\. A parent publishes the website at Go live to enable booking requests\./);
  assert.doesNotMatch(frame.srcdoc, /<\/script>\s*<script>/);
  const shown = frame.srcdoc;
  loads[0]();
  assert.equal(frame.srcdoc, shown, 'the preview load must not replace the document');
  loads[0]();
  assert.match(frame.srcdoc, /<!-- hb-preview-live -->/);
  assert.match(frame.srcdoc, /href="#book">Request a job/);
  assert.notEqual(frame.srcdoc, shown);
  loads[0]();
  assert.match(frame.srcdoc, /<!-- hb-preview-live -->/);
  loads[0]();
  assert.doesNotMatch(frame.srcdoc, /hb-preview-live/);
  assert.match(frame.srcdoc, /<!-- hb-preview-nav -->/);
  assert.match(frame.srcdoc, /id="book"/);
});

test('guard script scrolls in-page anchors, blocks sends, and ignores ordinary buttons', () => {
  const {context, frame, loads} = setup(() => sample);
  return context.refresh().then(() => {
    loads[0]();
    const script = frame.srcdoc.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.doesNotMatch(script, /<\/script>/);
    const hero = node('a', {id: 'heroCta', attrs: {href: '#book'}});
    const label = node('span', {parent: hero, text: 'Request a job'});
    label.nodeType = 3;
    const rates = node('a', {attrs: {href: '#rates'}});
    const privacy = node('a', {attrs: {href: '/privacy'}});
    const venmo = node('a', {attrs: {href: 'https://venmo.com/taylor', target: '_blank'}});
    const top = node('a', {attrs: {href: 'https://hustlebuilder.org/#book', target: '_top'}});
    const book = node('section', {id: 'book', top: 900});
    const rateBox = node('section', {id: 'rates', top: 420});
    const day = node('button', {className: 'day', text: '12'});
    day.onclick = () => 'picked';
    const panel = node('div');
    const btns = node('div', {className: 'btns', parent: panel});
    const send = node('button', {id: 'sendHost', parent: btns, text: 'Send my request'});
    send.onclick = () => { throw new Error('preview send must not run'); };
    const err = node('p', {id: 'err'});
    const {emit, listeners, scrolls} = runGuard(script, {readyState: 'loading', elements: [hero, rates, privacy, venmo, top, book, rateBox, day, panel, btns, send, err]});

    const request = emit('click', label);
    assert.equal(request.event.defaultPrevented, true);
    assert.equal(request.event.stopped, false);
    same(scrolls[0], {top: 900, behavior: 'smooth'});

    const jumped = emit('click', rates);
    assert.equal(jumped.event.defaultPrevented, true);
    same(scrolls[1], {top: 420, behavior: 'smooth'});

    for (const link of [privacy, venmo, top]) {
      const gone = emit('click', link);
      assert.equal(gone.event.defaultPrevented, true, link.getAttribute('href'));
      assert.equal(gone.event.stopped, false);
    }
    const middle = emit('auxclick', privacy);
    assert.equal(middle.event.defaultPrevented, true);

    const picked = emit('click', day);
    assert.equal(picked.event.defaultPrevented, false);
    assert.equal(picked.onclick, 'picked');

    const submitted = emit('submit', node('form'));
    assert.equal(submitted.event.defaultPrevented, true);

    const blocked = emit('click', send);
    assert.equal(blocked.event.defaultPrevented, true);
    assert.equal(blocked.event.stopped, true);
    assert.equal(blocked.onclick, null);
    assert.equal(err.textContent, 'Preview requests are not sent.');

    assert.equal(typeof listeners.DOMContentLoaded[0], 'function');
    listeners.DOMContentLoaded[0]();
    assert.equal(btns.removed, true);
    assert.equal(btns.parentNode, null);
    assert.equal(panel.replaced.className, 'small');
    assert.equal(panel.replaced.textContent, 'This is a draft preview. A parent publishes the website at Go live to enable booking requests.');
  });
});

test('published pages and security headers stay frame-blocking and free of the preview guard', async () => {
  const {genSite} = extractBuilderParts(source);
  const live = genSite(demoCfg());
  assert.match(live, /href="#book"/);
  assert.match(live, /id="sendHost"/);
  assert.doesNotMatch(live, /hb-preview-nav|Preview requests are not sent/);
  const draft = genSite(demoCfg({publish: null, inboxUrl: '', publicUrl: ''}));
  assert.match(draft, /This is a draft preview\. A parent publishes the website at Go live to enable booking requests\./);
  assert.doesNotMatch(draft, /id="sendHost"|id="sendInbox"|hb-preview-nav/);
  assert.match(source, /const LS="hustle-builder-v3"/);

  const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const sourcePath of ['/', '/index.html', '/parents']) {
    const block = vercel.headers.find(item => item.source === sourcePath);
    assert.equal(block.headers.find(item => item.key === 'X-Frame-Options').value, 'DENY');
    assert.match(block.headers.find(item => item.key === 'Content-Security-Policy').value, /frame-ancestors 'none'/);
  }
  const router = await readFile(new URL('../host/lib/router.mjs', import.meta.url), 'utf8');
  assert.match(router, /const PAGE_CSP = "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"/);
});

test('a headless fragment is not rewritten and a guarded document is not guarded twice', async () => {
  const fragment = '<h1>New business</h1>';
  const plain = setup(() => fragment);
  await plain.context.refresh();
  assert.equal(plain.frame.srcdoc, fragment);
  const guarded = setup(() => sample);
  await guarded.context.refresh();
  const once = guarded.frame.srcdoc;
  assert.equal(guarded.context.guardPreviewDocument(once), once);
  assert.equal(guarded.context.guardPreviewDocument('<p>No head</p>'), '<p>No head</p>');
});
