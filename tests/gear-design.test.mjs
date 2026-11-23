import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  normalizeGearBrand, gearMonogram, gearInkColors, gearFontFaces,
  buildGearArtworkSVG, buildGearPreviewSVG, gearFilename, gearExportSize,
  GEAR_COLORS, GEAR_STYLES, GEAR_PRINT_LINKS
} from '../assets/gear-studio.mjs';

const base = Object.freeze({ businessName: 'Drew’s Reading Corner', firstName: 'Drew', accent: '#245B45', font: 'workwear', tagline: 'A little practice. A lot of progress.', completedJobs: 3 });
const decode = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name]));
const printedName = svg => [...svg.matchAll(/<text[^>]*data-business-name="true"[^>]*>([^<]*)<\/text>/g)].map(match => decode(match[1])).join(' ');

test('every style prints the full business name safely, including punctuation, Unicode and long names', () => {
  const names = [
    'Drew’s Reading Corner',
    'Élodie & Milo’s Garden Crew',
    'A&B "Sparkle" <Wash>',
    'Neighborhood Helpers and Homework Practice for Busy Families After School',
    'お庭のヘルパー',
    'ExtremelyLongUnbrokenBusinessNameThatStillMustAppearInFull'
  ];
  for (const name of names) for (const {id:style} of GEAR_STYLES) for (const garment of ['shirt', 'cap', 'badge']) {
    const svg = buildGearArtworkSVG({...base, businessName:name}, {style, garment, operator:true});
    assert.equal(printedName(svg), name, `${style} ${garment}`);
    assert.doesNotMatch(svg, /<Wash>|<script|<foreignObject|\bonload=|\bonerror=/i);
  }
  assert.equal(gearMonogram('Drew’s Reading Corner'), 'DR');
  assert.equal(gearMonogram("Casey's Yard Crew"), 'CY');
  assert.equal(gearMonogram('Élodie & Milo'), 'ÉM');
});

test('art and preview generation cannot turn business text, colors or font names into active content', () => {
  const hostile = {...base,
    businessName: '"><script>alert(1)</script><image href="https://private.invalid/action"> & My Crew',
    tagline: '</text><foreignObject><iframe src="https://private.invalid/"></iframe></foreignObject>',
    accent: 'url(https://private.invalid/color)',
    font: '"><image href="https://private.invalid/font">'
  };
  for (const build of [buildGearArtworkSVG, buildGearPreviewSVG]) {
    const svg = build(hostile, {style:'bold', color:'" onload="alert(1)', idPrefix:'"><script>bad</script>'});
    assert.doesNotMatch(svg, /<(?:script|image|iframe|foreignObject|a)(?:\s|>)/i);
    assert.doesNotMatch(svg, /\s(?:onload|onerror|href)=["']|url\(https:/i);
    assert.match(svg, /&lt;script&gt;/);
    assert.doesNotMatch(svg, /font-family="[^"\n]*private/);
  }
});

test('private fields, sibling identity and links never enter downloadable art or filenames', () => {
  const input = Object.freeze({...base, phone:'PRIVATE-PHONE', address:'PRIVATE-HOME', email:'PRIVATE-EMAIL', parentName:'PRIVATE-PARENT', parentEmail:'PRIVATE-PARENT-EMAIL', manageUrl:'PRIVATE-MANAGE', actionToken:'PRIVATE-TOKEN', slug:'PRIVATE-SLUG', id:'PRIVATE-ID', sibling:{businessName:'PRIVATE-SIBLING'}});
  const before = JSON.stringify(input);
  for (const build of [buildGearArtworkSVG, buildGearPreviewSVG]) for (const garment of ['shirt', 'cap']) {
    const svg = build(input, {garment});
    assert.doesNotMatch(svg, /PRIVATE-|<a\b|href=/);
  }
  assert.doesNotMatch(gearFilename(input, {garment:'shirt'}), /PRIVATE-|private-/);
  assert.equal(JSON.stringify(input), before);
});

test('cap art is a separate single-ink design with bold plain lettering and no fine tagline', () => {
  for (const {id:style} of GEAR_STYLES) for (const {id:color} of GEAR_COLORS) {
    const svg = buildGearArtworkSVG({...base, font:'pacifico'}, {garment:'cap', style, color, operator:true});
    assert.equal(printedName(svg), base.businessName);
    assert.doesNotMatch(svg, /A little practice|HB-pacifico|<linearGradient|<radialGradient|opacity=/);
    assert.match(svg, /font-family="Barlow,sans-serif" font-weight="700" font-style="normal"/);
    const inks = new Set([...svg.matchAll(/(?:fill|stroke|color)="(#[A-Fa-f0-9]{6})"/g)].map(match => match[1]));
    assert.equal(inks.size, 1);
  }
});

test('selected garment colors produce readable artwork and shirt placement changes the mockup', () => {
  for (const cloth of GEAR_COLORS) for (const accent of ['#000000','#FFFFFF','#245B45','#D94B3D','#BEAA87']) {
    const inks = gearInkColors(accent, cloth.hex);
    assert.notEqual(inks.ink, cloth.hex);
    assert.notEqual(inks.accent, cloth.hex);
    assert.match(inks.ink, /^#[\dA-F]{6}$/);
  }
  const front = buildGearPreviewSVG(base, {placement:'compact', color:'forest', idPrefix:'first'});
  const back = buildGearPreviewSVG(base, {placement:'back', color:'forest', idPrefix:'second'});
  assert.match(front, /compact chest mark/); assert.match(back, /large back design/);
  assert.notEqual(front, back);
  const firstIds = [...front.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const secondIds = [...back.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.ok(firstIds.every(id => !secondIds.includes(id)), 'separate open studios have separate gradient IDs');
});

test('high-resolution exports are transparent artwork rather than garment mockups', () => {
  assert.deepEqual(gearExportSize('shirt'), {width:4500,height:4500});
  assert.deepEqual(gearExportSize('cap'), {width:4800,height:2400});
  for (const garment of ['shirt','cap','badge']) {
    const {width,height} = gearExportSize(garment), svg = buildGearArtworkSVG(base, {garment});
    assert.ok(svg.includes(`width="${width}" height="${height}"`));
    assert.doesNotMatch(svg, /<image\b|<rect\b|linearGradient|radialGradient|background:|fabric|shadow/);
  }
});

test('Operator designs unlock from saved milestones and cannot unlock in a device draft preview', () => {
  for (const count of [0,1,2,-4,NaN,Infinity]) {
    assert.equal(normalizeGearBrand({...base,completedJobs:count}).operatorUnlocked, false);
    assert.throws(() => buildGearArtworkSVG({...base,completedJobs:count}, {garment:'badge'}), /three completed jobs/);
    assert.doesNotMatch(buildGearArtworkSVG({...base,completedJobs:count}, {operator:true}), />OPERATOR</);
  }
  for (const count of [3,4,99]) assert.match(buildGearArtworkSVG({...base,completedJobs:count}, {operator:true}), />OPERATOR</);
  assert.equal(normalizeGearBrand({completedJobs:0,operatorUnlocked:true}).operatorUnlocked,true);
  const preview = normalizeGearBrand({...base, previewOnly:true, operatorUnlocked:true});
  assert.equal(preview.operatorUnlocked,false); assert.equal(preview.completedJobs,0);
  assert.throws(() => buildGearArtworkSVG(preview, {garment:'badge'}), /three completed jobs/);
  assert.doesNotMatch(buildGearArtworkSVG(base, {operator:false}), />OPERATOR</);
});

test('new drafts have safe defaults and export filenames cannot become paths or private links', () => {
  assert.equal(normalizeGearBrand({}).businessName, 'My Business');
  assert.equal(normalizeGearBrand({firstName:'Jamie'}).businessName, 'Jamie’s Business');
  assert.equal(normalizeGearBrand({theme:'neighbor'}).accent, '#245B45');
  const filename = gearFilename({businessName:'../Élodie & Milo <Crew> / *'}, {garment:'cap', style:'work-crew'}, 'svg');
  assert.equal(filename,'elodie-milo-crew-cap-work-crew.svg');
  assert.match(gearFilename(base,{style:'bold',placement:'back',operator:true} ), /shirt-bold-back-operator\.png$/);
});

test('exports embed existing local fonts and licenses without accepting arbitrary CSS or URLs', async () => {
  const css = await readFile(new URL('../assets/barlow.css', import.meta.url), 'utf8');
  const faces = gearFontFaces(css);
  assert.deepEqual(faces.map(({family,weight}) => [family,weight]), [['Barlow',700],['Barlow Condensed',900]]);
  assert.ok(faces.every(face => face.data.startsWith('d09GMg')));
  const svg = buildGearArtworkSVG(base, {fontCss:css});
  assert.match(svg, /data:font\/woff2;base64,/);
  assert.match(svg, /SIL OPEN FONT LICENSE Version 1.1/);
  assert.match(svg, /Copyright 2017 The Barlow Project Authors/);
  assert.doesNotMatch(svg, /src:url\(https?:/);
  const poison = css + '@font-face{font-family:"Private";src:url(https://private.invalid/)}body{background:url(https://private.invalid/)}';
  assert.doesNotMatch(buildGearArtworkSVG(base,{fontCss:poison,fontData:'</style><script>alert(1)</script>'}), /private.invalid|<script|body\{/);
  const libs = await readFile(new URL('../assets/print-libs.js', import.meta.url), 'utf8');
  const end = libs.indexOf('};') + 2, context = vm.createContext({});
  vm.runInContext(libs.slice(0,end) + ';globalThis.data=FONT_DATA;',context);
  for (const font of ['bungee','pacifico','playfair']) {
    const custom = buildGearArtworkSVG({...base,font},{fontCss:css,fontData:context.data[font]});
    assert.ok(custom.includes('font-family:"HB-' + font + '"'));
    assert.ok(custom.includes(context.data[font]));
  }
});

test('printer handoff uses fixed official upload pages without checkout parameters', () => {
  for (const url of Object.values(GEAR_PRINT_LINKS)) {
    const parsed = new URL(url);
    assert.equal(parsed.origin,'https://www.printful.com'); assert.equal(parsed.search,''); assert.equal(parsed.hash,'');
    assert.doesNotMatch(parsed.pathname,/checkout|order|cart/);
  }
  assert.equal(GEAR_PRINT_LINKS.cap,'https://www.printful.com/custom-embroidered-hats');
  assert.equal(GEAR_PRINT_LINKS.shirt,'https://www.printful.com/make-your-own-shirt');
});

test('font readiness resolves the real builder import stylesheet into embedded base faces and preserves the selected font', async () => {
  const [source, module, css, libs] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../assets/gear-studio.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../assets/barlow.css', import.meta.url), 'utf8'),
    readFile(new URL('../assets/print-libs.js', import.meta.url), 'utf8')
  ]);
  const inline = source.match(/<style id="fontcss">([\s\S]*?)<\/style>/)[1];
  const fontContext = vm.createContext({});
  vm.runInContext(libs.slice(0, libs.indexOf('};') + 2) + ';globalThis.data=FONT_DATA;', fontContext);
  const fontData = fontContext.data.anton, calls = [];
  class FontFaceStub {
    constructor(family, data, options) {
      assert.match(data, /^url\(data:font\/woff2;base64,d09GMg/);
      this.family = family; this.options = options;
    }
    async load() { return this; }
  }
  const context = vm.createContext({URL, FontFace:FontFaceStub, gearFontFaces,
    fetch:async(url,options) => { calls.push({url:url.href,options}); return {ok:true,text:async()=>css}; }
  });
  const start = module.indexOf('async function loadFonts('), end = module.indexOf('\nexport async function renderGearPNG', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(module.slice(module.indexOf('const FONTS ='), module.indexOf('\nconst BODY_FONT')), context);
  vm.runInContext(module.slice(start,end).replaceAll('import.meta.url', JSON.stringify(new URL('../assets/gear-studio.mjs', import.meta.url).href)), context);
  const brand = normalizeGearBrand({...base,font:'anton'});
  const loaded = await context.loadFonts({fontCss:inline,fontData}, brand);
  assert.deepEqual(Array.from(loaded.loaded, face => face.family).sort(), ['Barlow','Barlow Condensed','HB-anton']);
  const missingBase = gearFontFaces(inline).length < 2;
  assert.equal(calls.length, Number(missingBase));
  if (missingBase) {
    assert.equal(calls[0].url, new URL('../assets/barlow.css', import.meta.url).href);
    assert.equal(calls[0].options.credentials, 'omit');
  }
  const svg = buildGearArtworkSVG(brand, {fontCss:loaded.css,fontData});
  for (const family of ['Barlow','Barlow Condensed','HB-anton']) assert.ok(svg.includes('font-family:"'+family+'"'));
  assert.doesNotMatch(svg, /@import/);

  calls.length = 0;
  await context.loadFonts({fontCss:css,fontData}, brand);
  assert.equal(calls.length, 0, 'complete embedded fonts do not request another asset');
  await assert.rejects(context.loadFonts({fontCss:css,fontData:''}, brand), /Your business font is still loading/);
  assert.equal(calls.length, 0, 'missing selected-font data fails instead of borrowing another font or URL');

  calls.length = 0;
  const partial = css.match(/@font-face\{[^}]*font-weight:700;[^}]*\}/)[0] + '\n@import "https://private.invalid/font.css";';
  const merged = await context.loadFonts({fontCss:partial,fontData}, brand);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, new URL('../assets/barlow.css', import.meta.url).href);
  assert.equal(merged.loaded.length, 3, 'fallback merge does not duplicate a supplied face');
  assert.equal(gearFontFaces(merged.css, 'anton', fontData).length, 3);
});
