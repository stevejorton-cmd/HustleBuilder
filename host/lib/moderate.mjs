const BLOCKED = new Set(`
fuck shit bitch asshole bastard cunt piss slut whore porn nude sex sexy
cocaine heroin meth
suicide
nigger nigga faggot fag retard spic kike chink
`.trim().split(/\s+/));

// Borderline words. Allowed inside a yard, pet, or household phrase.
// "dick" is a common first name and is not blocked.
// "weed" is ordinary yard work and is not blocked.
const CONTEXT = new Set(`
kill
`.trim().split(/\s+/));

const PHRASES = [
  "weed eating", "weed eater", "weed eaters", "weed whacking", "weed whacker", "weed wacker",
  "weed whack", "weeding", "pulling weeds", "pull weeds", "kill weeds", "kill the weeds",
  "killing weeds", "kill dandelions", "kill the dandelions", "killing dandelions",
  "dandelion", "dandelions", "pet care", "dog walking", "dog walker", "pooper scooper",
  "poop scoop", "poop scooping", "dog poo", "dog poop", "poo", "poop", "litter box",
  "kitty litter", "kitty", "litter", "pet sitting", "cat sitting"
];

const SURNAMES = new Set(`
smith johnson williams brown jones garcia miller davis rodriguez martinez
hernandez lopez gonzalez wilson anderson thomas taylor moore jackson martin
lee perez thompson white harris sanchez clark ramirez lewis robinson walker
young allen king wright scott torres nguyen hill flores green adams nelson
baker hall rivera campbell mitchell carter roberts
`.trim().split(/\s+/));

const RESERVED = new Set(`
api admin www mail app hustle publish account login index static assets setup
host book auth consent checkout unpublish test vercel blob stripe resend about
privacy terms help support status health favicon robots sitemap builder boss
print flyer flyers gateway site me delete page pages
`.trim().split(/\s+/));

export function tokens(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
}

function stripped(value) {
  let text = " " + String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  const phrases = PHRASES.slice().sort((a, b) => b.length - a.length);
  for (const phrase of phrases) text = text.split(" " + phrase + " ").join(" ");
  return text;
}

export function wordHits(value) {
  const words = stripped(value).split(/\s+/).filter(Boolean);
  let block = "";
  let flag = "";
  for (const word of words) {
    if (!block && BLOCKED.has(word)) block = word;
    else if (!flag && CONTEXT.has(word)) flag = word;
  }
  return { block, flag };
}

export function pageIssue(html) {
  const hit = wordHits(visibleText(html));
  const word = hit.block || hit.flag;
  if (!word) return "";
  return "The page has a word that is not allowed: \"" + word + "\". Change that word and try again.";
}

export function checkPage(html) {
  return pageIssue(html);
}

export function checkSlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) return "Use letters, numbers, and dashes only.";
  if (s.length < 3 || s.length > 24) return "Use 3 to 24 characters.";
  const parts = s.split("-");
  if (RESERVED.has(s) || parts.some((p) => RESERVED.has(p))) return "That link name is reserved. Pick another.";
  if (parts.some((p) => BLOCKED.has(p))) return "That link name is not allowed.";
  if (parts.length >= 2 && SURNAMES.has(parts[parts.length - 1])) {
    return "That looks like a first and last name. Use a first name or a nickname, like sam or sam-yard.";
  }
  return "";
}

export function visibleText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

export function pageOk(html) {
  const s = String(html || "");
  if (!s.includes("<!-- hb-public -->")) return "That file is not a Hustle Builder page.";
  if (s.includes("hustle-boss-v1") || s.includes("hustle-builder-v3")) return "Customer records cannot be published. Publish the website only.";
  if (s.length > 2_000_000) return "That page is too big. Remove a photo and try again.";
  return "";
}
