import {readFile} from 'node:fs/promises';
import '../../config/season.js';

// Built from the same website generator and seasonal example rates as the
// front-page flyer. The template has no account, contact, payment, or booking
// destination; its sample request runs only in the visitor's browser.
const templates={
  fall:new URL('../demo/taylor-fall.html',import.meta.url),
  snow:new URL('../demo/taylor-snow.html',import.meta.url)
};
const loaded=new Map();
export async function taylorDemoHtml() {
  const file=globalThis.HB_SEASON_FILE;
  const active=file&&typeof file.activeSeason==='function'?file.activeSeason():(file?.SEASON==='snow'?'winter':'fall');
  const template=active==='winter'?'snow':'fall';
  if(!loaded.has(template))loaded.set(template,readFile(templates[template],'utf8'));
  return loaded.get(template);
}
