/* My Business Gear receives public brand data. It never reads an account, draft,
   job store, or contact details. Printing is a parent-managed handoff. */

export const GEAR_STYLES = Object.freeze([
  Object.freeze({ id: 'classic', name: 'Classic', detail: 'A clean, everyday mark' }),
  Object.freeze({ id: 'work-crew', name: 'Work Crew', detail: 'Made for getting it done' }),
  Object.freeze({ id: 'bold', name: 'Bold', detail: 'A name that stands out' })
]);
export const GEAR_COLORS = Object.freeze([
  Object.freeze({ id: 'charcoal', name: 'Charcoal', hex: '#252B2F' }),
  Object.freeze({ id: 'natural', name: 'Natural', hex: '#F1EADB' }),
  Object.freeze({ id: 'forest', name: 'Forest', hex: '#294A3B' }),
  Object.freeze({ id: 'navy', name: 'Navy', hex: '#263D56' }),
  Object.freeze({ id: 'white', name: 'White', hex: '#FFFFFF' })
]);
// Verified official pages. No artwork, identity, or checkout data is sent here.
export const GEAR_PRINT_LINKS = Object.freeze({
  shirt: 'https://www.printful.com/make-your-own-shirt',
  cap: 'https://www.printful.com/custom-embroidered-hats'
});
const FONTS = Object.freeze({
  workwear: { family: 'Barlow Condensed', weight: 900, italic: true },
  bebas: { family: 'HB-bebas', weight: 400, copyright: 'Bebas Neue. Copyright 2019 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue).' },
  anton: { family: 'HB-anton', weight: 400, copyright: 'Anton. Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont.git).' },
  bungee: { family: 'HB-bungee', weight: 400, copyright: 'Bungee. Copyright 2023 The Bungee Project Authors (https://github.com/djrrb/Bungee).' },
  blackops: { family: 'HB-blackops', weight: 400, copyright: 'Black Ops One. Copyright 2022 The Black Ops Project Authors (https://github.com/SorkinType/Black-Ops).' },
  bangers: { family: 'HB-bangers', weight: 400, copyright: 'Bangers. Copyright 2010 The Bangers Project Authors (https://github.com/googlefonts/bangers).' },
  fredoka: { family: 'HB-fredoka', weight: 700, copyright: 'Fredoka. Copyright 2016 The Fredoka Project Authors (https://github.com/hafontia/Fredoka-One).' },
  pacifico: { family: 'HB-pacifico', weight: 400, copyright: 'Pacifico. Copyright 2018 The Pacifico Project Authors (https://github.com/googlefonts/Pacifico).' },
  playfair: { family: 'HB-playfair', weight: 900, copyright: 'Playfair Display. Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display). Reserved Font Name Playfair Display.' },
  gochi: { family: 'HB-gochi', weight: 400, copyright: 'Gochi Hand. Copyright 2011, HT Fonts (www.htfonts.com info@htfonts.com). Reserved Font Names Gochi and Gochi Hand.' }
});
const BODY_FONT = Object.freeze({ family: 'Barlow', weight: 700, italic: false });
const BASE_FONT_COPYRIGHT = 'Barlow and Barlow Condensed. Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow).';
const OFL = "SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded,\nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.";

export function escapeGearSVG(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}
function cleanText(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
}
function color(value, fallback) {
  if (typeof value !== 'string' || !/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value)) return fallback;
  return (value.length === 4 ? '#' + [...value.slice(1)].map(c => c + c).join('') : value).toUpperCase();
}
export function normalizeGearBrand(input = {}) {
  const first = cleanText(input.firstName), count = Number(input.completedJobs), previewOnly = input.previewOnly === true;
  return Object.freeze({
    businessName: cleanText(input.businessName) || (first ? first + '’s Business' : 'My Business'),
    firstName: first, tagline: cleanText(input.tagline),
    accent: color(input.accent, input.theme === 'neighbor' ? '#245B45' : '#D94B3D'),
    font: Object.hasOwn(FONTS, input.font) ? input.font : 'workwear',
    completedJobs: previewOnly ? 0 : Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0,
    operatorUnlocked: !previewOnly && (input.operatorUnlocked === true || (Number.isFinite(count) && count >= 3)),
    previewOnly
  });
}
function normalizeSelection(input = {}) {
  return {
    style: GEAR_STYLES.some(style => style.id === input.style) ? input.style : 'classic',
    color: GEAR_COLORS.find(c => c.id === input.color) || GEAR_COLORS[0],
    placement: input.placement === 'back' ? 'back' : 'compact',
    garment: ['shirt', 'cap', 'badge'].includes(input.garment) ? input.garment : 'shirt',
    operator: input.operator === true
  };
}
function rgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function luminance(hex) {
  const [r, g, b] = rgb(hex).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return .2126 * r + .7152 * g + .0722 * b;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
function mix(a, b, amount) {
  const target = rgb(b);
  return '#' + rgb(a).map((v, i) => Math.round(v + (target[i] - v) * amount).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function gearInkColors(accent, garmentColor) {
  const cloth = color(garmentColor, GEAR_COLORS[0].hex), ink = luminance(cloth) > .4 ? '#1E2925' : '#FFF9EB';
  let highlight = color(accent, '#D94B3D');
  for (let step = 0; contrast(highlight, cloth) < 3 && step < 16; step++) highlight = mix(highlight, ink, .17);
  return { ink, accent: highlight };
}
export function gearMonogram(name) {
  const words = cleanText(name).replace(/['’]s\b/gi, '').match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 2).map(word => [...word][0]).join('').toLocaleUpperCase() || 'HB';
}
function wrapName(name, limit = 22) {
  const words = name.split(/\s+/), lines = [];
  let line = '';
  for (const word of words) {
    if (line && [...line + ' ' + word].length > limit && lines.length < 2) { lines.push(line); line = word; }
    else line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines;
}
function widthEstimate(text, size) {
  return [...text].reduce((sum, c) => sum + (/\s/.test(c) ? .28 : /[ilI1!.,'’]/.test(c) ? .25 : /[MW@&]/.test(c) ? .85 : /[^\u0000-\u024f]/.test(c) ? .9 : .54), 0) * size;
}
function textNode(value, x, y, size, fill, font = BODY_FONT, maxWidth = 850, extra = '') {
  const width = Math.min(maxWidth, widthEstimate(value, size));
  return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${escapeGearSVG(font.family)},sans-serif" font-weight="${font.weight}" font-style="${font.italic ? 'italic' : 'normal'}" font-size="${size}" fill="${fill}" textLength="${Math.max(1, width).toFixed(2)}" lengthAdjust="spacingAndGlyphs" ${extra}>${escapeGearSVG(value)}</text>`;
}
function nameBlock(brand, { x = 500, y = 490, size = 112, width = 840, font = FONTS[brand.font], limit = 22 } = {}) {
  const lines = wrapName(brand.businessName, limit), fitted = Math.min(size, 180 / Math.max(1, lines.length - .2));
  return { svg: lines.map((line, i) => textNode(line, x, y + i * fitted * 1.16, fitted, 'currentColor', font, width, 'data-business-name="true"')).join(''), bottom: y + (lines.length - 1) * fitted * 1.16 };
}
function star(x, y, radius, fill) {
  const points = Array.from({ length: 10 }, (_, i) => {
    const angle = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? radius * .46 : radius;
    return `${(x + Math.cos(angle) * r).toFixed(2)},${(y + Math.sin(angle) * r).toFixed(2)}`;
  }).join(' ');
  return `<polygon points="${points}" fill="${fill}"/>`;
}
function mark(brand, style, x, y, size, ink, accent, operator) {
  const initials = gearMonogram(brand.businessName);
  const frame = style === 'work-crew'
    ? `<path d="M-100-88H100V35L0 112-100 35Z" fill="none" stroke="${accent}" stroke-width="14" stroke-linejoin="round"/>`
    : style === 'bold'
      ? `<path d="M-105 84 12-106H69L-48 84Z M-38 106 72-72H119L9 106Z" fill="${accent}"/>`
      : `<circle r="100" fill="none" stroke="${accent}" stroke-width="13"/>`;
  // Bold initials sit below the diagonal mark, keeping a single solid ink usable.
  return `<g transform="translate(${x} ${y}) scale(${size / 220})">${frame}${style === 'bold' ? '' : textNode(initials, 0, 31, 107, ink, BODY_FONT, 164)}${operator ? star(86, -84, 26, accent) : ''}</g>`;
}
function operatorRibbon(y, ink, accent) {
  return `<path d="M275 ${y - 27}H725M275 ${y + 28}H725" fill="none" stroke="${accent}" stroke-width="5"/>${star(320, y, 16, accent)}${textNode('OPERATOR', 500, y + 15, 43, ink, BODY_FONT, 290)}${star(680, y, 16, accent)}`;
}
export function gearExportSize(garment = 'shirt') {
  return garment === 'cap' ? { width: 4800, height: 2400 } : { width: 4500, height: 4500 };
}
function artworkContent(brand, selection) {
  const { style, garment } = selection, { ink, accent } = gearInkColors(brand.accent, selection.color.hex), operator = brand.operatorUnlocked && selection.operator;
  if (garment === 'badge') {
    if (!brand.operatorUnlocked) throw new Error('The Operator badge unlocks after three completed jobs.');
    const name = nameBlock(brand, { y: 625, size: 86, width: 700 });
    return { viewBox: '0 0 1000 1000', content: `<g color="${ink}"><path d="M170 155Q500 20 830 155V580Q805 760 500 930Q195 760 170 580Z" fill="none" stroke="${accent}" stroke-width="24"/><path d="M220 185Q500 75 780 185" fill="none" stroke="${accent}" stroke-width="7"/>${star(500, 240, 78, accent)}${textNode('OPERATOR', 500, 438, 122, ink, BODY_FONT, 720)}${textNode('THREE JOBS. REAL PROGRESS.', 500, 505, 30, ink, BODY_FONT, 650)}${name.svg}</g>` };
  }
  if (garment === 'cap') {
    // One ink, sturdy lines and plain bold type for an embroidery review.
    // Fine taglines and small milestone text are deliberately omitted.
    const name = nameBlock(brand, { x: 760, y: 260, size: 106, width: 690, font: BODY_FONT, limit: 20 });
    return { viewBox: '0 0 1200 600', content: `<g color="${ink}">${mark(brand, style, 205, 290, 260, ink, ink, operator)}${name.svg}${style === 'work-crew' ? `<path d="M425 135H1090M425 455H1090" stroke="${ink}" stroke-width="14"/>` : ''}</g>` };
  }
  const name = nameBlock(brand, { y: style === 'bold' ? 515 : 490, size: style === 'bold' ? 126 : 112 });
  let content = mark(brand, style, 500, style === 'bold' ? 265 : 255, style === 'bold' ? 330 : 255, ink, accent, operator);
  if (style === 'work-crew') content += textNode('WORK CREW', 500, 105, 35, ink, BODY_FONT, 410) + `<path d="M115 398H885M115 773H885" stroke="${accent}" stroke-width="7"/>`;
  content += name.svg;
  if (brand.tagline) content += textNode(brand.tagline, 500, Math.max(730, name.bottom + 57), 33, ink, BODY_FONT, 790);
  if (operator) content += operatorRibbon(860, ink, accent);
  else if (style === 'bold') content += `<path d="M350 840H650" stroke="${accent}" stroke-width="15"/>`;
  return { viewBox: '0 0 1000 1000', content: `<g color="${ink}">${content}</g>` };
}

// Only allowlisted font families and WOFF2 data enter artwork. Caller CSS, remote
// URLs, SVG markup, and account links cannot enter an exported file as markup.
export function gearFontFaces(fontCss = '', font = 'workwear', fontData = '') {
  const faces = [];
  for (const block of String(fontCss).match(/@font-face\s*\{[^}]+\}/g) || []) {
    const family = block.match(/font-family\s*:\s*["'](Barlow(?: Condensed)?)["']/)?.[1];
    const weight = Number(block.match(/font-weight\s*:\s*(\d+)/)?.[1]);
    const italic = /font-style\s*:\s*italic/.test(block);
    const data = block.match(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/)?.[1];
    if (data && data.length < 400000 && ((family === 'Barlow' && weight === 700 && !italic) || (family === 'Barlow Condensed' && weight === 900 && italic))) faces.push({ family, weight, italic, data });
  }
  if (font !== 'workwear' && Object.hasOwn(FONTS, font) && typeof fontData === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(fontData) && fontData.length < 400000) faces.push({ ...FONTS[font], data: fontData });
  // A supplied stylesheet may include one base face and need the local fallback
  // for another. Keep each family/weight/style once in both previews and exports.
  return [...new Map(faces.map(face => [face.family + ':' + face.weight + ':' + !!face.italic, face])).values()];
}
function embeddedFonts(faces = []) {
  return faces.map(face => `@font-face{font-family:"${face.family}";font-weight:${face.weight};font-style:${face.italic ? 'italic' : 'normal'};src:url(data:font/woff2;base64,${face.data}) format("woff2")}`).join('');
}
export function buildGearArtworkSVG(input = {}, options = {}) {
  const brand = normalizeGearBrand(input), selection = normalizeSelection(options);
  const { viewBox, content } = artworkContent(brand, selection), size = gearExportSize(selection.garment);
  const faces = gearFontFaces(options.fontCss, brand.font, options.fontData), fonts = embeddedFonts(faces);
  const license = fonts ? `<metadata>${escapeGearSVG(BASE_FONT_COPYRIGHT + '\n' + (FONTS[brand.font].copyright || '') + '\n' + OFL)}</metadata>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${viewBox}" role="img" aria-label="${escapeGearSVG(brand.businessName + ' — ' + selection.garment + ' artwork')}"><title>${escapeGearSVG(brand.businessName)}</title>${license}${fonts ? `<defs><style>${fonts}</style></defs>` : ''}${content}</svg>`;
}
export function buildGearPreviewSVG(input = {}, options = {}) {
  const brand = normalizeGearBrand(input), selection = normalizeSelection(options);
  const { color: cloth, garment, placement } = selection, fabric = cloth.hex;
  const shade = mix(fabric, '#000000', .3), light = mix(fabric, '#FFFFFF', .12), art = artworkContent(brand, selection);
  const id = 'hbgear-' + String(options.idPrefix || 'preview').replace(/[^a-z0-9-]/gi, '') + '-' + (garment === 'cap' ? 'cap' : 'shirt');
  const defs = `<defs><linearGradient id="${id}-fabric" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${light}"/><stop offset=".52" stop-color="${fabric}"/><stop offset="1" stop-color="${shade}"/></linearGradient><radialGradient id="${id}-shadow"><stop stop-color="#15221B" stop-opacity=".16"/><stop offset="1" stop-color="#15221B" stop-opacity="0"/></radialGradient></defs>`;
  let body;
  if (garment === 'cap') {
    body = `<ellipse cx="305" cy="391" rx="235" ry="32" fill="url(#${id}-shadow)"/><path d="M131 297Q112 185 207 135Q271 97 346 124Q429 146 452 299L386 331 201 337Z" fill="url(#${id}-fabric)" stroke="${shade}" stroke-width="2"/><path d="M290 120Q260 194 269 309M290 120Q354 184 369 311M200 142Q177 222 183 310" fill="none" stroke="${shade}" stroke-width="2"/><path d="M290 124Q261 200 273 306M294 124Q359 189 372 306" fill="none" stroke="${light}" stroke-width="1.5"/><path d="M138 296Q279 259 450 296Q505 311 537 344Q449 400 252 367Q174 354 114 333Z" fill="${shade}"/><path d="M137 288Q279 253 448 290Q504 304 535 337Q448 391 253 359Q172 346 113 326Z" fill="url(#${id}-fabric)" stroke="${shade}" stroke-width="2"/><path d="M143 310Q292 289 499 342M165 325Q310 308 468 354M195 339Q324 329 430 364" fill="none" stroke="${light}" stroke-width="1.6" opacity=".6"/><ellipse cx="289" cy="120" rx="13" ry="7" fill="${shade}"/><ellipse cx="288" cy="117" rx="12" ry="5" fill="${fabric}"/><ellipse cx="196" cy="190" rx="3.5" ry="5" fill="${shade}"/><ellipse cx="372" cy="192" rx="3.5" ry="5" fill="${shade}"/><svg x="209" y="186" width="179" height="90" viewBox="${art.viewBox}">${art.content}</svg>`;
  } else {
    const back = placement === 'back';
    body = `<ellipse cx="300" cy="471" rx="209" ry="23" fill="url(#${id}-shadow)"/><path d="M208 66 251 51Q300 72 349 51L392 66 486 133 446 224 387 195 395 440Q300 458 205 440L213 195 154 224 114 133Z" fill="url(#${id}-fabric)" stroke="${shade}" stroke-width="2"/><path d="M208 66 234 135M392 66 366 135M214 191 207 423M386 191 393 423M125 140 159 211M475 140 441 211M211 429Q300 444 389 429" fill="none" stroke="${shade}" stroke-width="2" opacity=".7"/><path d="M220 196 213 418M380 196 387 418M134 143 164 206M467 143 437 206M212 433Q300 448 388 433" fill="none" stroke="${light}" stroke-width="1.6" opacity=".75"/><path d="M251 51Q300 ${back ? 69 : 125} 349 51L340 49Q300 ${back ? 62 : 103} 260 49Z" fill="${shade}"/><path d="M253 57Q300 ${back ? 77 : 130} 347 57" fill="none" stroke="${light}" stroke-width="2"/><path d="M222 164Q236 240 222 326M377 168Q363 249 380 325" fill="none" stroke="${shade}" stroke-width="8" opacity=".11"/><svg x="${back ? 224 : 306}" y="${back ? 126 : 131}" width="${back ? 153 : 67}" height="${back ? 207 : 78}" viewBox="${art.viewBox}" preserveAspectRatio="xMidYMid meet">${art.content}</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 500" role="img" aria-label="${escapeGearSVG(cloth.name + ' ' + garment + ' with ' + brand.businessName + (garment === 'shirt' ? ', ' + (placement === 'back' ? 'large back design' : 'compact chest mark') : ''))}"><title>${escapeGearSVG(brand.businessName + ' ' + garment + ' preview')}</title>${defs}${body}</svg>`;
}
export function gearFilename(input = {}, options = {}, extension = 'png') {
  const brand = normalizeGearBrand(input), selection = normalizeSelection(options);
  const stem = brand.businessName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'my-business';
  return `${stem}-${selection.garment}-${selection.style}${selection.garment === 'shirt' ? '-' + selection.placement : ''}${selection.operator && brand.operatorUnlocked ? '-operator' : ''}.${extension === 'svg' ? 'svg' : 'png'}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function button(label, className = '') { const node = element('button', className, label); node.type = 'button'; return node; }
function addStyle() {
  if (document.querySelector('link[data-hb-gear-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('./gear-studio.css', import.meta.url).href; link.dataset.hbGearStyle = 'true';
  document.head.append(link);
}
function showSVG(container, source) {
  // Builders escape all text and allowlist every style attribute. Parsing as SVG
  // also prevents a business name from becoming HTML.
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('The artwork could not be prepared.');
  container.replaceChildren(document.importNode(doc.documentElement, true));
}
async function loadFonts(props, brand) {
  let css = typeof props.fontCss === 'string' ? props.fontCss : '';
  let faces = gearFontFaces(css, brand.font, props.fontData);
  // The builder's FONT_CSS can contain only an @import and the font license.
  // Exported SVG images need embedded data, so resolve missing base faces from
  // our fixed local asset rather than following caller-supplied stylesheet URLs.
  if (!faces.some(face => face.family === 'Barlow') || !faces.some(face => face.family === 'Barlow Condensed')) {
    const response = await fetch(new URL('./barlow.css', import.meta.url), { credentials: 'omit' });
    if (!response.ok) throw new Error('The print fonts could not load. Reopen Gear Studio and try again.');
    css += '\n' + await response.text();
    faces = gearFontFaces(css, brand.font, props.fontData);
  }
  if (!faces.some(face => face.family === 'Barlow') || !faces.some(face => face.family === 'Barlow Condensed')) throw new Error('The print fonts could not load. Reopen Gear Studio and try again.');
  if (brand.font !== 'workwear' && !faces.some(face => face.family === FONTS[brand.font].family)) throw new Error('Your business font is still loading. Reopen Gear Studio in a moment.');
  const loaded = await Promise.all(faces.map(async face => {
    const font = new FontFace(face.family, `url(data:font/woff2;base64,${face.data}) format('woff2')`, { weight: String(face.weight), style: face.italic ? 'italic' : 'normal' });
    await font.load(); return font;
  }));
  return { css, loaded };
}
export async function renderGearPNG(svg, size) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('The artwork image could not load. Please try again.')); image.src = url; });
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not create a PNG. Try the SVG download.');
    context.clearRect(0, 0, size.width, size.height); context.drawImage(image, 0, 0, size.width, size.height);
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    // Release the large drawing buffer, particularly on small mobile devices.
    canvas.width = 1; canvas.height = 1;
    if (!png) throw new Error('This browser could not create a PNG. Try the SVG download.');
    return png;
  } finally { URL.revokeObjectURL(url); }
}
async function saveDownload(filename, blob, saveFile) {
  if (typeof saveFile === 'function') return saveFile(filename, blob, blob.type);
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener'; document.body.append(link); link.click();
  setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 6000);
  return { ok: true, how: 'browser' };
}

/** Open an isolated studio. onPreferenceChange(boolean) must persist the setting
 *  or throw; returning false / {ok:false,error?} also reports a failure.
 *  Return value: {close()}. Closing never cancels a server save already requested,
 *  but prevents stale UI updates and restores the original trigger's focus.
 */
export function openGearStudio(props = {}) {
  addStyle();
  const brand = normalizeGearBrand(props), previousFocus = props.returnFocus || document.activeElement;
  const uid = 'hbgear-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  const selection = { style: 'classic', color: brand.accent === '#245B45' ? 'natural' : 'charcoal', placement: 'compact', operator: brand.operatorUnlocked };
  let closed = false, busy = false, preferenceBusy = false, emailOptIn = props.emailOptIn === true, fontAssets = null;
  const ownedFonts = [];
  const dialog = element('dialog', 'hbgear'); dialog.setAttribute('aria-labelledby', uid + '-title');
  const inner = element('div', 'hbgear-inner'), header = element('header', 'hbgear-header'), heading = element('div');
  heading.append(element('p', 'hbgear-eyebrow', 'YOUR BUSINESS. YOUR LOOK.'));
  const title = element('h2', 'hbgear-title', 'My Business Gear'); title.id = uid + '-title';
  const business = element('p', 'hbgear-business', brand.businessName); heading.append(title, business);
  const closeButton = button('×', 'hbgear-close'); closeButton.setAttribute('aria-label', 'Close My Business Gear');
  header.append(heading, closeButton); inner.append(header);
  inner.append(element('p', 'hbgear-intro', 'Make it yours. Try a look, then keep the artwork — every preview and download is free.'));
  if (brand.previewOnly) inner.append(element('p', 'hbgear-draft-note', 'Preview from this device’s draft. A parent can open My Business Gear for saved job milestones.'));

  const content = element('div', 'hbgear-content');
  const previewArea = element('section', 'hbgear-preview-area'); previewArea.setAttribute('aria-label', 'Gear previews');
  const previewGrid = element('div', 'hbgear-preview-grid'), previewCards = {};
  for (const garment of ['shirt', 'cap']) {
    const card = element('figure', 'hbgear-preview-card hbgear-preview-' + garment), stage = element('div', 'hbgear-garment');
    const caption = element('figcaption', 'hbgear-preview-caption');
    caption.append(element('strong', '', garment === 'shirt' ? 'The everyday tee' : 'The crew cap'));
    const placement = element('span', '', ''); caption.append(placement);
    card.append(stage, caption); previewGrid.append(card); previewCards[garment] = { stage, placement };
  }
  previewArea.append(previewGrid, element('p', 'hbgear-preview-note', 'Design previews. The printer confirms the garment, color, fit, and artwork placement.'));

  if (!brand.previewOnly) {
    const milestone = element('section', 'hbgear-milestone');
    const badge = element('div', 'hbgear-rank-symbol', brand.operatorUnlocked ? '★' : '3'); badge.setAttribute('aria-hidden', 'true');
    const copy = element('div', 'hbgear-rank-copy');
    copy.append(element('p', 'hbgear-eyebrow', brand.operatorUnlocked ? 'YOU EARNED THIS' : 'YOUR NEXT MILESTONE'));
    copy.append(element('h3', '', brand.operatorUnlocked ? 'Operator unlocked.' : 'Three jobs. Operator status.'));
    copy.append(element('p', '', brand.operatorUnlocked ? 'Three jobs marked Done by a parent. Your Operator design and badge are yours to keep. No purchase needed.' : `${Math.min(brand.completedJobs, 3)} of 3 jobs marked Done by a parent. Your free Operator design and badge unlock at three. No purchase needed.`));
    const progress = element('div', 'hbgear-progress'); progress.setAttribute('role', 'img'); progress.setAttribute('aria-label', `${Math.min(brand.completedJobs, 3)} of 3 jobs marked Done by a parent`);
    for (let index = 0; index < 3; index++) progress.append(element('span', index < brand.completedJobs || brand.operatorUnlocked ? 'is-complete' : ''));
    if (!brand.operatorUnlocked) copy.append(progress);
    milestone.append(badge, copy); previewArea.append(milestone);
  }

  const controls = element('section', 'hbgear-controls'); controls.setAttribute('aria-label', 'Personalize your gear');
  function fieldset(legend) { const field = element('fieldset', 'hbgear-field'); field.append(element('legend', '', legend)); controls.append(field); return field; }
  const styles = fieldset('1. Pick your style'), styleButtons = [], styleList = element('div', 'hbgear-style-list'); styles.append(styleList);
  for (const item of GEAR_STYLES) {
    const pick = button('', 'hbgear-style'); pick.dataset.gearStyle = item.id;
    const icon = element('span', 'hbgear-style-icon', item.id === 'classic' ? '◯' : item.id === 'work-crew' ? '▱' : '↗'); icon.setAttribute('aria-hidden', 'true');
    const words = element('span'); words.append(element('strong', '', item.name), element('small', '', item.detail)); pick.append(icon, words);
    pick.addEventListener('click', () => { selection.style = item.id; render(); }); styleList.append(pick); styleButtons.push(pick);
  }
  const colors = fieldset('2. Choose a garment color'), colorList = element('div', 'hbgear-swatches'), colorButtons = [];
  colors.append(colorList); const colorName = element('p', 'hbgear-color-name'); colors.append(colorName);
  for (const item of GEAR_COLORS) {
    const pick = button('', 'hbgear-swatch'); pick.dataset.gearColor = item.id; pick.style.setProperty('--swatch', item.hex);
    pick.setAttribute('aria-label', item.name); pick.title = item.name; pick.append(element('span', 'hbgear-swatch-tick', '✓'));
    pick.addEventListener('click', () => { selection.color = item.id; render(); }); colorList.append(pick); colorButtons.push(pick);
  }
  const placements = fieldset('3. Place your shirt design'), placementList = element('div', 'hbgear-segment'), placementButtons = []; placements.append(placementList);
  for (const [value, label] of [['compact', 'Compact chest mark'], ['back', 'Large back design']]) {
    const pick = button(label); pick.dataset.gearPlacement = value; pick.addEventListener('click', () => { selection.placement = value; render(); });
    placementList.append(pick); placementButtons.push(pick);
  }
  placements.append(element('p', 'hbgear-help', 'The cap gets a simple, bold version of your mark.'));
  if (brand.operatorUnlocked) {
    const label = element('label', 'hbgear-check'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.dataset.gearOperator = 'true';
    label.append(check, element('span', '', 'Add my free Operator detail'));
    check.addEventListener('change', () => { selection.operator = check.checked; render(); }); controls.append(label);
  }
  content.append(previewArea, controls); inner.append(content);

  const downloads = element('section', 'hbgear-downloads'), downloadHeading = element('div', 'hbgear-section-heading');
  downloadHeading.append(element('h3', '', 'Keep your design'), element('p', '', 'Transparent artwork, ready to share with a printer.')); downloads.append(downloadHeading);
  const downloadGrid = element('div', 'hbgear-download-grid'), downloadButtons = [];
  for (const garment of ['shirt', 'cap', ...(brand.operatorUnlocked ? ['badge'] : [])]) {
    const box = element('div', 'hbgear-download-card');
    box.append(element('h4', '', garment === 'shirt' ? 'Shirt artwork' : garment === 'cap' ? 'Cap artwork' : 'Your Operator badge'));
    const size = gearExportSize(garment); box.append(element('p', '', `${size.width.toLocaleString('en-US')} × ${size.height.toLocaleString('en-US')} px · transparent PNG`));
    const actions = element('div', 'hbgear-download-actions');
    for (const extension of ['png', 'svg']) {
      const action = button(extension === 'png' ? 'Download PNG' : 'Vector SVG', extension === 'png' ? 'hbgear-primary' : 'hbgear-secondary');
      action.setAttribute('aria-label', `Download ${garment} ${extension.toUpperCase()}`); action.dataset.gearDownload = garment + '-' + extension; action.disabled = true;
      action.addEventListener('click', () => download(garment, extension)); actions.append(action); downloadButtons.push(action);
    }
    box.append(actions); downloadGrid.append(box);
  }
  downloads.append(downloadGrid, element('p', 'hbgear-print-note', 'Cap files use one solid ink and bold lettering. Ask the printer to review letter size, thread colors, and digitization before embroidery. PNG and SVG artwork are not embroidery stitch files.'));
  const status = element('p', 'hbgear-status', 'Preparing your print fonts…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); downloads.append(status); inner.append(downloads);

  if (props.canShop === true && !brand.previewOnly) {
    const handoff = element('section', 'hbgear-handoff'), copy = element('div');
    copy.append(element('h3', '', 'Want to make it real?'), element('p', '', 'A parent can download the PNG, choose a garment at a printer, and upload the artwork. Check the final size, colors, price, and delivery before ordering. Buying gear is optional and never changes your progress.'));
    const links = element('div', 'hbgear-print-links');
    for (const [garment, label] of [['shirt', 'Shirts at Printful ↗'], ['cap', 'Embroidered hats at Printful ↗']]) {
      const link = element('a', 'hbgear-vendor-link', label); link.href = GEAR_PRINT_LINKS[garment]; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; links.append(link);
    }
    copy.append(element('p', 'hbgear-help', 'Opens a separate website. Upload required; your artwork is not sent automatically. You can also use your own local print shop.'));
    handoff.append(copy, links); inner.append(handoff);
  } else inner.append(element('p', 'hbgear-parent-note', 'Your downloads are free. If you want printed gear, ask a parent to choose a printer with you.'));

  if (props.canManagePreference === true && !brand.previewOnly && typeof props.onPreferenceChange === 'function') {
    const preference = element('section', 'hbgear-preference'), label = element('label', 'hbgear-check'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = emailOptIn; input.dataset.gearEmailOptIn = 'true';
    const words = element('span'); words.append(element('strong', '', 'Email me when this business earns Operator'), element('small', '', 'Optional parent email about the three-job milestone and free gear designs. Turn it off any time. Turning it on after Operator is earned does not send a past milestone.'));
    label.append(input, words); const prefStatus = element('p', 'hbgear-preference-status'); prefStatus.setAttribute('role', 'status');
    input.addEventListener('change', async () => {
      if (preferenceBusy || closed) return;
      const desired = input.checked; preferenceBusy = true; input.disabled = true; prefStatus.textContent = 'Saving your preference…';
      try {
        const result = await props.onPreferenceChange(desired);
        if (result === false || result?.ok === false) throw new Error(result?.error || 'Your preference could not be saved.');
        if (closed) return;
        emailOptIn = desired; prefStatus.textContent = desired ? 'Milestone email is on for this business.' : 'Milestone email is off for this business.';
      } catch (error) {
        if (closed) return;
        input.checked = emailOptIn; prefStatus.textContent = 'Could not save this change. ' + (error instanceof Error ? error.message : 'Please try again.');
      } finally { preferenceBusy = false; if (!closed) input.disabled = false; }
    });
    preference.append(label, prefStatus); inner.append(preference);
  }
  dialog.append(inner); document.body.append(dialog);

  function render() {
    if (closed) return;
    for (const garment of ['shirt', 'cap']) {
      showSVG(previewCards[garment].stage, buildGearPreviewSVG(brand, { ...selection, garment, idPrefix: uid }));
      previewCards[garment].placement.textContent = garment === 'cap' ? 'Front · simple embroidery artwork' : selection.placement === 'back' ? 'Back · large design' : 'Front · compact chest mark';
    }
    for (const pick of styleButtons) pick.setAttribute('aria-pressed', String(pick.dataset.gearStyle === selection.style));
    for (const pick of colorButtons) pick.setAttribute('aria-pressed', String(pick.dataset.gearColor === selection.color));
    for (const pick of placementButtons) pick.setAttribute('aria-pressed', String(pick.dataset.gearPlacement === selection.placement));
    const cloth = GEAR_COLORS.find(item => item.id === selection.color); colorName.textContent = cloth.name + ' · artwork contrast adjusts automatically';
  }
  async function download(garment, extension) {
    if (closed || busy || !fontAssets) return;
    busy = true; for (const action of downloadButtons) action.disabled = true;
    status.textContent = 'Preparing your ' + garment + ' ' + extension.toUpperCase() + '…';
    // Capture the selection so clicks while rendering cannot mix two designs.
    const chosen = { ...selection, garment, fontCss: fontAssets.css, fontData: props.fontData };
    try {
      const svg = buildGearArtworkSVG(brand, chosen);
      const blob = extension === 'svg' ? new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }) : await renderGearPNG(svg, gearExportSize(garment));
      if (closed) return;
      const result = await saveDownload(gearFilename(brand, chosen, extension), blob, props.saveFile);
      if (closed) return;
      if (result?.ok === false) status.textContent = result.declined ? 'Download canceled. Your design is still here.' : 'The file could not be saved. Please try again.';
      else status.textContent = `${garment === 'badge' ? 'Operator badge' : garment === 'cap' ? 'Cap artwork' : 'Shirt artwork'} download prepared. Check your downloads or save prompt.`;
    } catch (error) { if (!closed) status.textContent = error instanceof Error ? error.message : 'The download could not be prepared. Please try again.'; }
    finally { busy = false; if (!closed) for (const action of downloadButtons) action.disabled = false; }
  }
  function close() {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close(); dialog.remove();
    for (const font of ownedFonts) document.fonts.delete(font);
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
    if (typeof props.onClose === 'function') props.onClose();
  }
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  render(); dialog.showModal(); closeButton.focus({ preventScroll: true });
  loadFonts(props, brand).then(assets => {
    if (closed) return;
    fontAssets = assets;
    for (const font of assets.loaded) { document.fonts.add(font); ownedFonts.push(font); }
    render(); for (const action of downloadButtons) action.disabled = false;
    status.textContent = 'Your artwork is ready. Downloads contain the design with a transparent background.';
  }).catch(error => { if (!closed) status.textContent = error instanceof Error ? error.message : 'The print fonts could not load. Reopen Gear Studio and try again.'; });
  return Object.freeze({ close });
}
