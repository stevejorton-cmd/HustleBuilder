const BLOCKED = new Set(`
fuck shit bitch asshole bastard dick cunt piss slut whore porn nude sex sexy
cocaine heroin meth weed
kill suicide
nigger nigga faggot fag retard spic kike chink
`.trim().split(/\s+/));

const SURNAMES = new Set(`
smith johnson williams brown jones garcia miller davis rodriguez martinez
hernandez lopez gonzalez wilson anderson thomas taylor moore jackson martin
lee perez thompson white harris sanchez clark ramirez lewis robinson walker
young allen king wright scott torres nguyen hill flores green adams nelson
baker hall rivera campbell mitchell carter roberts
`.trim().split(/\s+/));

const BUSINESS = new Set(`
yard yards lawn lawns snow mow mows mowing crew co service services hustle
edge cuts cut clear clears works work pros pro local north south east west
city care outdoor outdoors property season seasons ice salt walk walks drive
driveway crew
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

export function hasBlocked(value) {
  return tokens(value).some((t) => BLOCKED.has(t));
}

export function checkSlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) return "Use letters, numbers, and dashes only.";
  if (s.length < 3 || s.length > 24) return "Use 3 to 24 characters.";
  const parts = s.split("-");
  if (RESERVED.has(s) || parts.some((p) => RESERVED.has(p))) return "That link name is reserved. Pick another.";
  if (parts.some((p) => BLOCKED.has(p))) return "That link name is not allowed.";
  if (parts.some((p) => SURNAMES.has(p))) return "That looks like a last name. Use a first name or a business nickname, like sam or sam-yard.";
  if (parts.length >= 2 && parts.slice(1).some((p) => !BUSINESS.has(p))) {
    return "Use a first name or a business nickname, not a first and last name. Try sam or sam-yard.";
  }
  return "";
}

export function visibleText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

export function checkPage(html) {
  const text = visibleText(html);
  if (hasBlocked(text)) return "The page has a word that is not allowed. Change the business name or the tagline.";
  return "";
}

export function pageOk(html) {
  const s = String(html || "");
  if (!s.includes("<!-- hb-public -->")) return "That file is not a Hustle Builder page.";
  if (s.includes("hustle-boss-v1") || s.includes("hustle-builder-v3")) return "Customer records cannot be published. Publish the website only.";
  if (s.length > 2_000_000) return "That page is too big. Remove a photo and try again.";
  return "";
}
