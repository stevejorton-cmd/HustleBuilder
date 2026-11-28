import { createHash, randomBytes } from 'node:crypto';
import { store, transaction } from './store.mjs';
import { queueMail } from './mail.mjs';

// This ledger deliberately has no retention expiry. Request rows and draft
// payloads expire, but a business's earned progress must not disappear with
// them. Only the account-erasure hook deletes the ledger.
export const OPERATOR_JOBS = 3;
const VERSION = 1;
const ID = /^gb_[a-f0-9]{24}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const CODE = /^[a-z0-9]{8}$/;
const FONTS = new Set(['', 'workwear', 'bebas', 'anton', 'bungee', 'blackops', 'bangers', 'fredoka', 'pacifico', 'playfair', 'gochi']);
const PALETTES = { ember:'#FF5B14', mower:'#D94B3D', forest:'#245B45', gold:'#F5B800', cobalt:'#3E8BFF', crimson:'#FF3B30', rose:'#F0568A', violet:'#A78BFA', teal:'#14B8A6', lime:'#A3E635' };
const THEMES = {
  hustle:['#20262C','#F4F1EB'], neighbor:['#FBF8F2','#203B30'], bold:['#14171A','#F1EFEA'],
  clean:['#FFFFFF','#191C1E'], paper:['#F7F1E3','#2B2118'], sport:['#0C0E11','#F1EFEA'],
  friendly:['#FFFBF5','#33261A'], midnight:['#060809','#EDF2F5'], retro:['#F6EDD8','#26324B']
};
const clean = (value, length = 80) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, length);
const slugOf = value => SLUG.test(String(value || '').trim().toLowerCase()) ? String(value).trim().toLowerCase() : '';
const escapeHtml = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validAccount = account => object(account) && /^[a-z0-9_-]{1,100}$/i.test(String(account.id || '')) && account.emailVerifiedAt && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(account.email || ''));
const authError = () => ({ok:false,status:401,error:'auth',message:'Sign in with the verified parent email to open My Business Gear.'});
const businessError = () => ({ok:false,status:404,error:'business',message:'That business is not available in this parent account.'});
// A multi-kid account has no family gear catalog. This error names nobody.
const ownerError = () => ({ok:false,status:404,error:'owner',message:'Open My Business Gear from your own page.'});
const accountSlugs = account => [...new Set([account.slug, ...(Array.isArray(account.slugs) ? account.slugs : [])].map(slugOf).filter(Boolean))];
const ledgerKey = account => 'gear/' + account.id + '.json';
const completionKey = (account, row) => createHash('sha256').update(account.id + ':' + row.id).digest('hex');
const isBooking = row => object(row) && (!row.kind || row.kind === 'booking');

async function readJson(key) {
  const raw = await (await store()).get(key);
  if (!raw) return null;
  // Corrupt durable progress must fail closed, not silently reset and award
  // the same achievement (or send its message) a second time.
  return JSON.parse(raw);
}
async function writeJson(key, value) { await (await store()).put(key, JSON.stringify(value)); }
function originOf(origin) {
  try {
    const url = new URL(process.env.PUBLIC_ORIGIN || origin || 'https://hustlebuilder.org');
    if (url.protocol === 'https:' || (process.env.PUBLISH_TEST_MODE === '1' && url.protocol === 'http:')) return url.origin;
  } catch { /* use the public HTTPS origin below */ }
  return 'https://hustlebuilder.org';
}
async function stateFor(account) {
  const ledger = await readJson(ledgerKey(account));
  if (ledger && (ledger.version !== VERSION || ledger.accountId !== account.id || !object(ledger.businesses))) throw new Error('Invalid gear ledger');
  return {account, ledger:ledger || {version:VERSION,accountId:account.id,businesses:{}}, changed:!ledger, contexts:[]};
}
async function saveState(state) { if (state.changed) await writeJson(ledgerKey(state.account), state.ledger); }
function setValue(state, entry, key, value) {
  if (JSON.stringify(entry[key]) !== JSON.stringify(value)) { entry[key] = value; state.changed = true; }
}
function addAlias(state, entry, slug) {
  if (slug && !entry.aliases.includes(slug)) { entry.aliases.push(slug); state.changed = true; }
}
async function redirectsTo(account, from, to) {
  const seen = new Set();
  let slug = from;
  while (slug && !seen.has(slug) && seen.size < 10) {
    if (slug === to) return true;
    seen.add(slug);
    const meta = await readJson('pages/' + slug + '.json');
    if (!meta || meta.accountId !== account.id || meta.status !== 'redirect') return false;
    slug = slugOf(meta.to);
  }
  return false;
}

async function ensureBusiness(state, slug, meta) {
  if (!meta || meta.accountId !== state.account.id || meta.status === 'redirect') return null;
  let entry = ID.test(String(meta.gearBusinessId || '')) ? state.ledger.businesses[meta.gearBusinessId] : null;
  if (entry && entry.slug !== slug && !entry.aliases.includes(slug) && !await redirectsTo(state.account, entry.slug, slug)) entry = null;
  if (!entry) entry = Object.values(state.ledger.businesses).find(item => item.slug === slug);
  if (!entry) {
    const id = ID.test(String(meta.gearBusinessId || '')) && !own(state.ledger.businesses, meta.gearBusinessId)
      ? meta.gearBusinessId : 'gb_' + randomBytes(12).toString('hex');
    entry = {id,slug,aliases:[slug],createdAt:new Date().toISOString(),completed:{},completedJobs:0,earnedAt:'',milestoneEmails:false,operatorEmailDecision:''};
    state.ledger.businesses[id] = entry;
    state.changed = true;
  }
  if (!Array.isArray(entry.aliases) || !object(entry.completed)) throw new Error('Invalid gear business');
  addAlias(state, entry, slug);
  setValue(state, entry, 'slug', slug);
  for (const former of Array.isArray(state.account.formerSlugs) ? state.account.formerSlugs : []) {
    const old = slugOf(former);
    if (old && await redirectsTo(state.account, old, slug)) addAlias(state, entry, old);
  }
  if (meta.gearBusinessId !== entry.id) {
    meta.gearBusinessId = entry.id;
    await writeJson('pages/' + slug + '.json', meta);
  }
  return entry;
}

function draftSlug(draft) {
  const direct = slugOf(draft?.publish?.slug || draft?.slug);
  if (direct) return direct;
  const value = clean(draft?.siteUrl || draft?.publicUrl, 300);
  if (!value) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
    return /^https?:$/.test(url.protocol) ? slugOf(url.pathname.replace(/^\/|\/$/g, '')) : '';
  } catch { return ''; }
}
function draftMatches(draft, entry, meta, explicitlyBound = false) {
  if (!object(draft)) return false;
  const linkedSlug = draftSlug(draft);
  if (linkedSlug) return entry.aliases.includes(linkedSlug);
  if (!explicitlyBound) return false;
  // A new draft has no live URL yet. The publish request supplies its owned
  // code; reject obvious sibling-name mismatches instead of borrowing it.
  const first = clean(draft.first, 40), biz = clean(draft.bizName || draft.biz, 80);
  return !(first && meta.names?.first && first !== clean(meta.names.first,40))
    && !(biz && meta.names?.biz && biz !== clean(meta.names.biz,80));
}
async function ownedDraft(account, code) {
  if (!CODE.test(String(code || ''))) return null;
  const rec = await readJson('drafts/' + code + '.json');
  return rec?.accountId === account.id && object(rec.draft) ? rec : null;
}
async function resolveDraft(state, entry, meta, requestedCode) {
  const explicit = String(requestedCode || '').trim().toLowerCase();
  const candidates = [...new Set([explicit, meta.gearDraftCode, entry.draftCode].filter(code => CODE.test(String(code || ''))))];
  for (const code of candidates) {
    const rec = await ownedDraft(state.account, code);
    if (rec && draftMatches(rec.draft, entry, meta, true)) return {code,draft:rec.draft};
  }
  // Legacy pages did not store their draft code. Recover only an unambiguous
  // matching published URL from this owner's draft index, never the family's
  // most recent draft or a best guess based on the child's name alone.
  const matches = [];
  for (const key of await (await store()).list('draftby/' + state.account.id + '/')) {
    const code = key.split('/').pop();
    if (candidates.includes(code)) continue;
    const rec = await ownedDraft(state.account, code);
    if (rec && draftMatches(rec.draft, entry, meta)) matches.push({code,draft:rec.draft});
  }
  return matches.length === 1 ? matches[0] : null;
}
function brandFor(entry, meta, draft) {
  const old = object(entry.brand) ? entry.brand : {};
  const savedDraft = old.source === 'draft';
  const source = draft || savedDraft ? 'draft' : 'page';
  const pageTheme = object(meta.card) && own(meta.card,'theme') ? meta.card.theme : old.theme;
  const themeValue = draft ? draft.theme : savedDraft ? old.theme || pageTheme : pageTheme;
  const theme = !themeValue || themeValue === 'energy' ? 'hustle' : own(THEMES, themeValue) ? themeValue : 'bold';
  const legacyTheme = draft && (!draft.theme || draft.theme === 'energy');
  const pagePalette = Object.keys(PALETTES).find(key => PALETTES[key].toLowerCase() === String(meta.card?.accent || '').toLowerCase());
  const paletteValue = legacyTheme ? 'mower' : draft?.palette || (savedDraft ? old.palette : pagePalette || old.palette);
  const palette = own(PALETTES,paletteValue) ? paletteValue : theme === 'neighbor' ? 'forest' : 'mower';
  const fontValue = draft ? draft.siteFont ?? draft.font ?? '' : old.font || '';
  const fallbackAccent = /^#[a-f0-9]{6}$/i.test(String(meta.card?.accent || '')) ? meta.card.accent : old.accent || PALETTES[palette];
  return {
    businessName:clean(draft?.bizName || draft?.biz || meta.names?.biz || old.businessName || meta.card?.title || entry.slug),
    kidName:clean(draft?.first || meta.names?.first || old.kidName,40),
    tagline:clean(draft?.tagline || (savedDraft ? old.tagline || meta.card?.line : meta.card?.line || old.tagline),140),
    font:FONTS.has(fontValue) ? fontValue : '', palette, theme,
    look:clean(legacyTheme ? 'night' : draft?.look || old.look || (['neighbor','clean','paper','friendly','retro'].includes(theme) ? 'day' : 'night'),16),
    type:clean(draft?.type || old.type,24),
    accent:draft ? PALETTES[palette] : savedDraft ? old.accent || fallbackAccent : fallbackAccent,
    background:THEMES[theme][0], ink:THEMES[theme][1], source
  };
}
async function refreshBrand(state, entry, meta, draftCode) {
  const resolved = await resolveDraft(state,entry,meta,draftCode);
  if (resolved) {
    setValue(state,entry,'draftCode',resolved.code);
    if (meta.gearDraftCode !== resolved.code) {
      meta.gearDraftCode = resolved.code;
      await writeJson('pages/' + entry.slug + '.json',meta);
    }
  }
  setValue(state,entry,'brand',brandFor(entry,meta,resolved?.draft));
}
async function currentBusinesses(state, {refresh = true} = {}) {
  for (const slug of accountSlugs(state.account)) {
    const meta = await readJson('pages/' + slug + '.json');
    if (meta && (meta.accountId !== state.account.id || meta.status === 'redirect')) continue;
    // An offline page keeps metadata. A retained ledger can still supply free
    // gear if that metadata is missing but the account still owns the slug.
    const entry = meta ? await ensureBusiness(state,slug,meta) : Object.values(state.ledger.businesses).find(item => item.slug === slug);
    if (!entry) continue;
    if (refresh && meta) await refreshBrand(state,entry,meta);
    state.contexts.push({entry,meta});
  }
}
function entryForRow(state, row) {
  if (!isBooking(row) || typeof row.id !== 'string' || !row.id || row.id.length > 160 || (row.accountId && row.accountId !== state.account.id)) return null;
  const requestedId = row.gearBusinessId;
  if (requestedId) return state.contexts.find(({entry}) => entry.id === requestedId)?.entry || null;
  const slug = slugOf(row.slug);
  const hits = state.contexts.filter(({entry}) => entry.aliases.includes(slug));
  return hits.length === 1 ? hits[0].entry : null;
}
function addCompletion(state, entry, row, {historical = false} = {}) {
  const key = completionKey(state.account,row);
  if (own(entry.completed,key)) return {counted:false,crossed:false};
  entry.completed[key] = new Date().toISOString();
  entry.completedJobs = Object.keys(entry.completed).length;
  state.changed = true;
  const crossed = entry.completedJobs >= OPERATOR_JOBS && !entry.earnedAt;
  if (crossed) {
    entry.earnedAt = new Date().toISOString();
    entry.operatorEmailDecision = historical ? 'historical' : entry.milestoneEmails === true ? 'eligible' : 'opted_out';
  }
  return {counted:true,crossed};
}
async function migrateRetainedCompletions(state) {
  const rows = await readJson('requests/' + state.account.id + '.json');
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.status !== 'done') continue;
    const entry = entryForRow(state,row);
    if (entry) addCompletion(state,entry,row,{historical:true});
  }
}
// Gear belongs to the kid named on the page. There is no separate kid login.
// An empty name does not join unrelated pages into one visible group.
function ownerKey(entry) {
  const name = clean(entry?.brand?.kidName || '', 40).toLocaleLowerCase();
  return name || ('id:' + String(entry?.id || ''));
}
function businessView(entry, meta, origin) {
  const base = originOf(origin);
  return {
    id:entry.id,slug:entry.slug,kid:entry.brand?.kidName || '',business:entry.brand?.businessName || entry.slug,
    brand:entry.brand || brandFor(entry,meta || {},null),completedJobs:entry.completedJobs,
    operator:{threshold:OPERATOR_JOBS,earned:!!entry.earnedAt,earnedAt:entry.earnedAt || ''},
    milestoneEmails:entry.milestoneEmails === true,
    gearUrl:base + '/?gear=1&business=' + entry.id,
    previewUrl:meta ? base + '/api/card/' + entry.slug + '.png' : ''
  };
}
function responseFor(state, {businessId,slug,kid,origin} = {}) {
  const contexts = state.contexts;
  const requestedKid = clean(kid, 40).toLocaleLowerCase();
  let pool = contexts;
  if (requestedKid) {
    pool = contexts.filter(({entry}) => ownerKey(entry) === requestedKid);
    if (!pool.length) return businessError();
  }
  let selected = null;
  if (businessId || slug) {
    selected = pool.find(({entry}) => (!businessId || entry.id === businessId) && (!slug || entry.aliases.includes(slugOf(slug))));
    if (!selected) return businessError();
    const key = ownerKey(selected.entry);
    pool = pool.filter(({entry}) => ownerKey(entry) === key);
  } else if (!requestedKid) {
    if (!contexts.length) return {ok:true,businesses:[],selectedBusinessId:'',downloadsFree:true,physicalPurchaseOptional:true};
    const keys = new Set(contexts.map(({entry}) => ownerKey(entry)));
    // The parent session may open one kid at a time. It may not download
    // every sibling's designs by asking for the account with no page.
    if (keys.size > 1) return ownerError();
    pool = contexts;
    selected = contexts.length === 1 ? contexts[0] : null;
  }
  const businesses = pool.map(({entry,meta}) => businessView(entry,meta,origin));
  const selectedBusinessId = selected ? selected.entry.id : businesses.length === 1 ? businesses[0].id : '';
  return {ok:true,businesses,selectedBusinessId,downloadsFree:true,physicalPurchaseOptional:true};
}
async function prepare(account) {
  const state = await stateFor(account);
  await currentBusinesses(state);
  await migrateRetainedCompletions(state);
  return state;
}

/** Parent-session read, including offline businesses and expired plans.
    The verified parent is a separate role and can open one owned business
    (its page, or the gear link mailed for that business). The payload never
    includes a different kid. A family jobs code is not a gear credential. */
export async function getGear(account, options = {}) {
  if (!validAccount(account)) return authError();
  return transaction(async () => {
    const state = await prepare(account), result = responseFor(state,options);
    await saveState(state);
    return result;
  },{keys:['account:' + account.id]});
}

/** Preference changes never replay an already-earned achievement. */
export async function updateGearPreferences(account, options = {}) {
  if (!validAccount(account)) return authError();
  if (typeof options.milestoneEmails !== 'boolean' || (!options.businessId && !options.slug)) return {ok:false,status:400,error:'preference',message:'Choose a business and set milestone emails on or off.'};
  return transaction(async () => {
    const state = await prepare(account), view = responseFor(state,options);
    if (!view.ok) return view;
    const entry = state.ledger.businesses[view.selectedBusinessId];
    setValue(state,entry,'milestoneEmails',options.milestoneEmails);
    setValue(state,entry,'preferenceUpdatedAt',new Date().toISOString());
    if (!options.milestoneEmails) {
      // Honor withdrawal even if a previously opted-in notice is still queued.
      for (const key of await (await store()).list('mailqueue/')) {
        const message = await readJson(key);
        if (message?.ownerId === account.id && message?.gearBusinessId === entry.id && message?.kind === 'gear-operator') await (await store()).del(key);
      }
      if (entry.operatorEmailDecision === 'queued') setValue(state,entry,'operatorEmailDecision','opted_out');
    }
    await saveState(state);
    return responseFor(state,options);
  },{keys:['account:' + account.id]});
}

/** Bind the exact owned draft supplied by this page's publish operation. */
export async function syncGearBusiness(account, {slug,draftCode} = {}) {
  if (!validAccount(account)) return authError();
  slug = slugOf(slug);
  if (!slug) return businessError();
  return transaction(async () => {
    const state = await stateFor(account), meta = await readJson('pages/' + slug + '.json');
    const entry = await ensureBusiness(state,slug,meta);
    if (!entry) return businessError();
    await refreshBrand(state,entry,meta,draftCode);
    await saveState(state);
    return {ok:true,businessId:entry.id};
  },{keys:['account:' + account.id]});
}

/** Called only inside the server-authorized parent Done transition. */
export async function recordGearCompletion(account, row, options = {}) {
  if (!validAccount(account)) return authError();
  if (options.parentAuthorized !== true || !['new','confirmed'].includes(options.previousStatus) || row?.status !== 'done' || !isBooking(row)) return {ok:true,counted:false};
  return transaction(async () => {
    const state = await prepare(account), entry = entryForRow(state,row);
    if (!entry) { await saveState(state); return {ok:true,counted:false}; }
    const result = addCompletion(state,entry,row);
    let queued = false;
    if (result.crossed && entry.operatorEmailDecision === 'eligible') {
      const view = responseFor(state,{businessId:entry.id,origin:options.origin}).businesses.find(item => item.id === entry.id);
      const name = view.business, url = view.gearUrl;
      const lead = name + ' earned Operator: ' + OPERATOR_JOBS + ' jobs marked Done by a parent.';
      const free = 'Open My Business Gear to preview and save your free business designs. Downloads are free. Ordering printed items is optional.';
      const preview = view.previewUrl ? '<p>Public business card preview:</p><img src="' + escapeHtml(view.previewUrl) + '" alt="Public business card for ' + escapeHtml(name) + '" width="600" style="display:block;max-width:100%;height:auto">' : '';
      await queueMail({
        kind:'gear-operator',ownerId:account.id,gearBusinessId:entry.id,to:account.email,
        subject:clean(name + ' earned Operator',150),
        text:'Congratulations! ' + lead + '\n\n' + free + '\n\nMy Business Gear:\n' + url + '\n\nYou chose milestone emails for this business. Change that choice in My Business Gear. Sign in with your parent email to continue.\n',
        html:'<div style="font:18px/1.5 system-ui,sans-serif;color:#1d2226"><h1>Operator earned</h1><p>Congratulations! ' + escapeHtml(lead) + '</p><p>' + escapeHtml(free) + '</p>' + preview + '<p><a href="' + escapeHtml(url) + '">Open My Business Gear</a></p><p>You chose milestone emails for this business. Change that choice in My Business Gear. Sign in with your parent email to continue.</p></div>'
      });
      entry.operatorEmailDecision = 'queued';
      entry.operatorEmailQueuedAt = new Date().toISOString();
      state.changed = true;
      queued = true;
    }
    await saveState(state);
    return {ok:true,...result,queued,businessId:entry.id,completedJobs:entry.completedJobs,operatorEarned:!!entry.earnedAt};
  },{keys:['account:' + account.id]});
}

/** Run after copying the old page metadata and creating its redirect. */
export async function renameGearBusiness(account, from, next) {
  if (!validAccount(account)) return authError();
  from = slugOf(from); next = slugOf(next);
  if (!from || !next) return businessError();
  return transaction(async () => {
    const state = await stateFor(account), meta = await readJson('pages/' + next + '.json');
    if (!meta || meta.accountId !== account.id || !await redirectsTo(account,from,next)) return businessError();
    let old = Object.values(state.ledger.businesses).find(item => item.slug === from || item.aliases.includes(from));
    if (old) {
      if (meta.gearBusinessId && meta.gearBusinessId !== old.id) return businessError();
      meta.gearBusinessId = old.id;
      addAlias(state,old,next);
    }
    const entry = await ensureBusiness(state,next,meta);
    if (!entry) return businessError();
    addAlias(state,entry,from);
    await refreshBrand(state,entry,meta);
    await writeJson('pages/' + next + '.json',meta);
    await saveState(state);
    return {ok:true,businessId:entry.id};
  },{keys:['account:' + account.id]});
}

/** Account erasure owns the only ledger deletion path. */
export async function deleteGearAccount(account) {
  if (!account || !/^[a-z0-9_-]{1,100}$/i.test(String(account.id || ''))) return;
  return transaction(async () => {
    const s = await store();
    await s.del(ledgerKey(account));
    for (const key of await s.list('mailqueue/')) {
      const message = await readJson(key);
      if (message?.ownerId === account.id && message?.kind === 'gear-operator') await s.del(key);
    }
  },{keys:['account:' + account.id]});
}
