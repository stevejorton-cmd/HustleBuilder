// A Venmo username neighbors can pay. Strip a leading @. Letters, numbers,
// hyphens, and underscores only. Anything else is refused so a parent
// cannot paste an email or phone into the payment handle.
export function cleanVenmo(value) {
  const name = String(value || "").trim().replace(/^@+/, "");
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(name) || !/[A-Za-z]/.test(name)) return "";
  return name;
}

// "Will: Mow a small yard Nov 21" — first name, job, and the day they picked.
export function venmoNote({ kid, service, when } = {}) {
  const who = String(kid || "").trim();
  const job = String(service || "").replace(/\s+/g, " ").trim();
  const day = String(when || "").replace(/\s+/g, " ").trim();
  return [who ? who + ":" : "", job, day].filter(Boolean).join(" ").slice(0, 120);
}

// Opens the Venmo app on a phone with the recipient, amount, and note filled in.
// No price means no amount, so the neighbor types it.
export function venmoPayUrl(username, { amount, note } = {}) {
  const user = cleanVenmo(username);
  if (!user) return "";
  const parts = ["txn=pay"];
  const raw = String(amount == null ? "" : amount).replace(/[^0-9.]/g, "");
  const num = Number(raw);
  if (raw && Number.isFinite(num) && num > 0 && num <= 999) parts.push("amount=" + encodeURIComponent(String(Math.round(num * 100) / 100)));
  const text = String(note || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (text) parts.push("note=" + encodeURIComponent(text));
  return "https://venmo.com/" + encodeURIComponent(user) + "?" + parts.join("&");
}
