import assert from "node:assert/strict";

export function extractBuilderParts(src, fontData, fontCss = "") {
  const lines = src.split("\n");
  const extractFn = (name) => {
    const start = lines.findIndex((l) => new RegExp("^(async )?function " + name + "\\b").test(l));
    if (start < 0) return null;
    let depth = 0, begun = false;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; begun = true; }
        else if (ch === "}") { depth--; if (begun && depth === 0) return lines.slice(start, i + 1).join("\n"); }
      }
    }
    return null;
  };
  const extractConst = (name) => {
    const start = lines.findIndex((l) => new RegExp("^(const|let|var) " + name + "\\b").test(l));
    if (start < 0) return null;
    let depth = 0, seen = false;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) { if ("{[(".includes(ch)) { depth++; seen = true; } if ("}])".includes(ch)) depth--; }
      if (seen && depth <= 0 && /;\s*$/.test(lines[i])) return lines.slice(start, i + 1).join("\n");
      if (!seen && /;\s*$/.test(lines[i])) return lines.slice(start, i + 1).join("\n");
    }
    return null;
  };
  const consts = ["RIGS", "TAGS", "PET_ART", "FONT_META", "FONT_ORDER", "SITE_THEMES", "SPAL", "SVGH"];
  const fns = ["heroFitPx", "genSite", "normalizeBrandStyle", "brandArt", "bannerArt", "cineUrl", "sceneArt", "scene", "defHours", "esc", "fmtPrice", "priceNum", "cleanPrice", "petPortrait", "petFace", "petSrc", "petHero", "jobSrc", "schedSummary", "siteFontCss", "siteTheme", "themeCss", "dayCss", "typeInfo", "t12", "inboxValid", "house", "silTree", "siteMain"];
  let code = "";
  for (const c of consts) { const t = extractConst(c); assert.ok(t, "const " + c); code += t + "\n"; }
  for (const f of fns) { const t = extractFn(f); assert.ok(t, "fn " + f); code += t + "\n"; }
  return new Function("FONT_DATA", "FONT_CSS", "NOISE", "let sceneN=0;\n" + code + "\nreturn { genSite, siteTheme, normalizeBrandStyle, SITE_THEMES, fmtPrice, cleanPrice, petFace, PET_ART, siteFontCss };")(fontData || {}, fontCss, "");
}
export function demoCfg(extra) {
  const sched = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ on: i >= 1 && i <= 6, from: "16:00", to: "20:00" }));
  return {
    type: "lawn", look: "night", sky: "dusk", art: "dusk", font: "", pets: [], snowTrigger: "2",
    inboxUrl: "", inboxKey: "", publicUrl: "", parent2: "", phone2Digits: "", email2: "",
    seasonOn: false, seasonPrice: "", promise: "If something isn't right, tell my parent.",
    first: "Taylor", town: "Lincoln", biz: "Taylor's Lawn Co.", tagline: "Straight lines. Clean edges. Done right.",
    parentName: "Molly", phone: "", phoneDigits: "4025550100", showPhone: true,
    email: "parent@example.com", venmo: "taylor-lawn", about: "I'm Taylor. I show up and do it right.",
    services: [{ n: "Mow a small yard", p: "$25" }, { n: "Leaf raking", p: "$30" }],
    palette: "ember", days: sched.map((x) => x.on), sched, hours: "", proof: [], reviews: [],
    publish: { slug: "demo", book: "http://sites.test/api/book" }, ...(extra || {})
  };
}

