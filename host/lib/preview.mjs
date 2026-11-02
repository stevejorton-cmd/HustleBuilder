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
  if (out.includes("</head>")) out = out.replace("</head>", tags + "</head>");
  else out = tags + out;
  if (url && !out.includes("Report this page")) {
    const slug = String(url).split("/").filter(Boolean).pop();
    if (slug && /^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
      const link = `<p style="font:15px/1.4 system-ui,sans-serif;margin:2rem"><a href="/api/report/${escAttr(slug)}">Report this page</a></p>`;
      out = out.includes("</body>") ? out.replace("</body>", link + "</body>") : out + link;
    }
  }
  return out;
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
