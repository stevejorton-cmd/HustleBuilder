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
  if (out.includes("</head>")) return out.replace("</head>", tags + "</head>");
  return tags + out;
}

export function hidePhone(html, phone) {
  let out = String(html || "");
  out = out.replace(/href="tel:[^"]*"/gi, 'href="#book"');
  out = out.replace(/href="sms:[^"]*"/gi, 'href="#book"');
  const raw = String(phone || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (raw) out = out.split(raw).join("");
  if (digits.length >= 10) out = out.split(digits).join("");
  return out;
}
