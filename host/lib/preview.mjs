import { heroFitBoot } from "./hero.mjs";
import { cleanVenmo, venmoNote, venmoPayUrl } from "./venmo.mjs";

function escAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function decoratePage(html, { title, description, image, url, indexable }) {
  let out = String(html || "");
  out = out.replace(/<meta[^>]*name=["'](?:description|robots|twitter:[^"']+)["'][^>]*>/gi, "");
  out = out.replace(/<meta[^>]*property=["']og:[^"']+["'][^>]*>/gi, "");
  const robots = indexable ? "index,follow" : "noindex,nofollow";
  const tags = [
    `<meta name="description" content="${escAttr(description)}">`,
    `<meta name="robots" content="${robots}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta property="og:description" content="${escAttr(description)}">`,
    `<meta property="og:url" content="${escAttr(url)}">`,
    image ? `<meta property="og:image" content="${escAttr(image)}">` : "",
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escAttr(title)}">`,
    `<meta name="twitter:description" content="${escAttr(description)}">`,
    image ? `<meta name="twitter:image" content="${escAttr(image)}">` : ""
  ].filter(Boolean).join("");
  // Function replacers: a title like "Lawns from $$" or one holding "$&"
  // must land as typed, not be read as a replace() pattern.
  if (out.includes("</head>")) out = out.replace("</head>", () => tags + "</head>");
  else out = tags + out;
  if (url && !out.includes("Report this page")) {
    const slug = String(url).split("/").filter(Boolean).pop();
    if (slug && /^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
      const link = `<p style="font:15px/1.4 system-ui,sans-serif;margin:2rem"><a href="/api/report/${escAttr(slug)}">Report this page</a></p>`;
      out = out.includes("</body>") ? out.replace("</body>", () => link + "</body>") : out + link;
    }
  }
  return out;
}

// A public page must not carry a parent's email or phone: not in a link,
// not in the page text, and not in the script config. Neighbors use the
// booking form. bookings@ and support@ are our own addresses and stay.
// Only the dog-walk price on Maryn's stored page. The 10000 timeouts in
// the page script must stay. Returns the new html, or null if the two
// price spots are not exactly as published.
export function setDogWalkPrice(html) {
  const pairs = [
    ['Dog walk, 15 minutes</span><span class="p">$10000</span>', 'Dog walk, 15 minutes</span><span class="p">$10</span>'],
    ['"n":"Dog walk, 15 minutes","p":"$10000"', '"n":"Dog walk, 15 minutes","p":"$10"']
  ];
  let out = String(html || "");
  if (out.includes(pairs[0][1]) && out.includes(pairs[1][1]) && !out.includes("$10000")) return out;
  for (const [from, to] of pairs) {
    if (out.split(from).length !== 2) return null;
    out = out.replace(from, to);
  }
  return out;
}

function firstPricedService(html) {
  const re = /"n"\s*:\s*"([^"]+)"\s*,\s*"p"\s*:\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const price = match[2].replace(/[^0-9.]/g, "");
    if (price && Number(price) > 0) return { name: match[1], price };
  }
  return { name: "", price: "" };
}

// Already published pages keep whatever pay line they were saved with.
// The family's Venmo name lives on the account, so the live page grows a
// Pay with Venmo link from that name. The amount is the job the neighbor
// has picked. The note is the kid's first name and the job, never an
// address, email, or phone.
export function familyVenmo(html, username, kid) {
  const user = cleanVenmo(username);
  let out = String(html || "");
  if (!user || out.includes('id="hb-venmo"')) return out;
  const fromPage = String(html || "").match(/"first"\s*:\s*"([^"\\]{1,40})"/);
  const who = String(kid || (fromPage && fromPage[1]) || "").trim().split(/\s+/)[0].replace(/[^A-Za-z'.-]/g, "").slice(0, 40);
  const job = firstPricedService(out);
  const href = venmoPayUrl(user, { amount: job.price, note: venmoNote({ kid: who, service: job.name }) });
  const safeHref = escAttr(href);
  if (/id=["']venmoPay["']/i.test(out)) {
    out = out.replace(/(<a\b[^>]*id=["']venmoPay["'][^>]*)(>)/i, (full, open, end) => {
      const next = /href\s*=/.test(open) ? open.replace(/href\s*=\s*["'][^"']*["']/, `href="${safeHref}"`) : open + ` href="${safeHref}"`;
      return next + end;
    });
  } else {
    const link = `<a class="venmo" id="venmoPay" href="${safeHref}" target="_blank" rel="noopener">Pay with Venmo</a>`;
    if (/id=["']book["']/i.test(out)) out = out.replace(/(<section\b[^>]*id=["']book["'][^>]*>)/i, (tag) => tag + link);
    else if (out.includes("</body>")) out = out.replace("</body>", () => link + "</body>");
    else out += link;
  }
  const boot = `<script id="hb-venmo">(function(){var user=${JSON.stringify(user)};var kid=${JSON.stringify(who)};function price(){var sel=document.getElementById("svc");var name=sel?sel.value:"";var list=(window.__C&&window.__C.services)||[];var p="";for(var i=0;i<list.length;i++){if(list[i]&&list[i].n===name)p=String(list[i].p||"").replace(/[^0-9.]/g,"");}return p;}function href(){var parts=["txn=pay"];var raw=price();var num=Number(raw);if(raw&&isFinite(num)&&num>0&&num<=999)parts.push("amount="+encodeURIComponent(String(Math.round(num*100)/100)));var sel=document.getElementById("svc");var job=sel&&sel.value?sel.value:"";var note=[kid?kid+":":"",job].filter(Boolean).join(" ").replace(/\\s+/g," ").trim().slice(0,120);if(note)parts.push("note="+encodeURIComponent(note));return "https://venmo.com/"+encodeURIComponent(user)+"?"+parts.join("&");}function paint(){var a=document.getElementById("venmoPay");if(!a)return;a.href=href();}var sel=document.getElementById("svc");if(sel)sel.addEventListener("change",paint);paint();})();</script>`;
  return out.includes("</body>") ? out.replace("</body>", () => boot + "</body>") : out + boot;
}

export function stripParentContact(html) {
  let out = hidePhone(String(html || ""), "");
  out = out.replace(/window\.location\.href="mailto:"\+C\.email\+[\s\S]*?;/g, 'var sh=document.getElementById("sendHost");if(C.publish&&C.publish.book&&sh){sh.click();return;}var bk=document.getElementById("book");if(bk)bk.scrollIntoView({block:"start"});');
  out = out.replace(/href\s*=\s*(["'])mailto:(?!bookings@hustlebuilder\.org|support@hustlebuilder\.org)[^"']*\1/gi, 'href="#book"');
  out = out.replace(/"(email|email2|phone|phone2|phoneDigits|phone2Digits)"\s*:\s*"(?:\\.|[^"\\])*"/g, '"$1":""');
  out = out.replace(/[A-Z0-9._%+-]+@(?!hustlebuilder\.org\b)[A-Z0-9.-]+\.[A-Z]{2,}/gi, "");
  if (!out.includes("report-link-contrast")) {
    const css = `<style id="report-link-contrast">a[href^="/api/report"],footer a{color:var(--bone,CanvasText);font-weight:800;text-decoration:underline;text-underline-offset:3px;font-size:16px}</style>`;
    out = out.includes("</head>") ? out.replace("</head>", () => css + "</head>") : css + out;
  }
  if (!/href=["']\/privacy["']/.test(out)) {
    const links = `<p class="small"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>`;
    if (out.includes("</footer>")) out = out.replace("</footer>", () => links + "</footer>");
    else if (out.includes("</body>")) out = out.replace("</body>", () => links + "</body>");
  }
  out = out.replace(
    "copyBook.onclick=function(){copyPlain(bookPlain(),copyBook);}",
    "copyBook.onclick=function(){if(!build(false))return; copyPlain(bookPlain(),copyBook);}"
  );
  if (out.includes('value="Something else"') && !out.includes("What job do you need?")) {
    const boot = `<script id="hb-other-note">(function(){var s=document.getElementById("svc"),n=document.getElementById("note");if(!s||!n)return;function sync(){if(s.value==="Something else")n.placeholder="What job do you need?";}s.addEventListener("change",sync);sync();})();</script>`;
    out = out.includes("</body>") ? out.replace("</body>", () => boot + "</body>") : out + boot;
  }
  out = kidOwned(out);
  if (out.includes('class="hero') && !out.includes("function fitHero(") && !out.includes('id="hb-hero-fit"')) {
    const boot = heroFitBoot();
    out = out.includes("</body>") ? out.replace("</body>", () => boot + "</body>") : out + boot;
  }
  return out;
}

// "student-owned" and "student owned" become "kid-owned". Capitalization
// follows the original word, and a phrase that starts a line is "Kid-owned".
export function kidOwned(html) {
  return String(html || "").replace(/student([ -])owned/gi, (full, _sep, offset, whole) => {
    const student = full.slice(0, 7);
    const owned = full.slice(full.length - 5);
    const prev = offset === 0 ? "\n" : whole[offset - 1];
    const lineStart = prev === "\n" || prev === "\r";
    const kid = student === "STUDENT" ? "KID" : (lineStart || student[0] === "S" ? "Kid" : "kid");
    const own = owned === "OWNED" ? "OWNED" : (owned[0] === "O" ? "Owned" : "owned");
    return kid + "-" + own;
  });
}

export function hidePhone(html,phone) {
  // Preserve scripts, CSS and image data byte-for-byte. Phone-shaped digit
  // sequences can appear inside embedded photos and must not be rewritten.
  const pattern=/(?:\+?1[ .()-]*)?(?:\(?\d{3}\)?[ .-]*)\d{3}[ .-]*\d{4}/g;
  const raw=String(phone||'').trim();
  return String(html||'').replace(/<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<[^>]*>|[^<]+/gi,part=>{
    if(/^<(?:script|style)\b/i.test(part))return part;
    if(part.startsWith('<'))return part.replace(/href\s*=\s*(["'])\s*(?:tel|sms):[\s\S]*?\1/gi,'href="#book"');
    if(raw)part=part.split(raw).join('');
    return part.replace(pattern,'');
  });
}
