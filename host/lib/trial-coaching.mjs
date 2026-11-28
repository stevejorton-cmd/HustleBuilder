// Parent-facing trial coaching emails focused on "Time to First Job".
// Enabled in production via TRIAL_COACHING_EMAILS=1 so existing renewal tests
// stay deterministic while live families get helpful Day 1 & Day 4 nudges
// alongside the built-in Day 11 (trial-3) and Day 14 (trial-0) reminders.

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanUrl(url) {
  const s = String(url || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

/**
 * Determine which coaching email (if any) is due based on elapsed days since trialStartedAt.
 * Returns "day1" (days 1..2) or "day4" (days 4..7), or null otherwise.
 */
export function coachingBucket(trialStartedAt, now = Date.now()) {
  const startMs = Date.parse(String(trialStartedAt || ""));
  if (!Number.isFinite(startMs) || startMs > now) return null;
  const elapsedDays = Math.floor((now - startMs) / 864e5);
  if (elapsedDays >= 1 && elapsedDays <= 2) return "day1";
  if (elapsedDays >= 4 && elapsedDays <= 7) return "day4";
  return null;
}

/**
 * Build parent-facing Day 1 or Day 4 coaching email copy.
 */
export function buildTrialCoachingMail({ bucket, biz, slug, origin, seasonLabel = "$9.99", yearLabel = "$19.99" } = {}) {
  const name = String(biz || "").trim() || "your kid’s neighborhood business";
  const base = String(origin || "https://hustlebuilder.org").replace(/\/+$/, "");
  const pageUrl = slug ? cleanUrl(`${base}/${slug}`) : cleanUrl(base);
  const myJobsUrl = cleanUrl(`${base}/?jobs=1`);

  if (bucket === "day1") {
    const postCopy = `Hi neighbors! My kid started a small neighborhood business (${name}). Every request comes to me first and I confirm every job. If you could use a hand, you can check open days and request a spot here: ${pageUrl}`;
    const subject = `Quick win for ${name}: get your first neighbor request tonight`;
    const text = [
      `Your page for ${name} is live!`,
      pageUrl ? `Live link: ${pageUrl}` : "",
      "",
      "The fastest way for a kid to land their first neighborhood job is a 3-sentence post from you in your neighborhood Facebook group or Nextdoor. Feel free to copy and tweak this:",
      "",
      `"${postCopy}"`,
      "",
      "Every booking request comes to your inbox first — nothing is scheduled until you confirm.",
      "",
      `Open your family Boss Board & Playbook scripts anytime: ${myJobsUrl}`
    ].filter((line) => line !== undefined).join("\n");

    const html = `<div style="font:17px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2226;max-width:36rem">
<p>Your page for <b>${esc(name)}</b> is live!</p>
${pageUrl ? `<p><a href="${esc(pageUrl)}" style="color:#a33128;font-weight:700">${esc(pageUrl)}</a></p>` : ""}
<p>The fastest way to land a first neighborhood job is a quick note from you in your neighborhood Facebook group or Nextdoor. Copy and tweak this:</p>
<blockquote style="margin:12px 0;padding:12px 16px;background:#f4f1ec;border-left:4px solid #d94b3d;border-radius:8px">${esc(postCopy)}</blockquote>
<p>Every request comes to you first — nothing is booked until you approve it.</p>
<p><a href="${esc(myJobsUrl)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#14181d;color:#fff;text-decoration:none;font-weight:700">Open My Jobs &amp; Playbook Scripts</a></p>
</div>`;

    return { subject, text, html };
  }

  if (bucket === "day4") {
    const subject = `Flyer tip for ${name} (even if you don’t own a printer)`;
    const text = [
      `Checking in on ${name} during your free 14-day trial!`,
      "",
      "Families who drop 15–20 QR flyers or door hangers on nearby porches usually get their first booking much faster — neighbors love scanning a code right at their door.",
      "",
      "3 quick tips that work:",
      "1. Print black-and-white flyers right from the Flyers tab (no color ink needed).",
      "2. No printer at home? Save the flyer PDF and print 20 black-and-white copies for a couple dollars at your local library, Staples, or FedEx Office.",
      "3. Go together for 15 minutes — remind your kid to stay outside on porches and never step inside a house.",
      "",
      `Your trial stays free for 14 days total. If you decide to keep going afterward, it is a one-time ${seasonLabel} season pass (or ${yearLabel} for a full year), covers every kid in your family, and never auto-renews.`,
      pageUrl ? `\nYour live page: ${pageUrl}` : ""
    ].join("\n");

    const html = `<div style="font:17px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2226;max-width:36rem">
<p>Checking in on <b>${esc(name)}</b> during your free 14-day trial!</p>
<p>Putting 15–20 QR flyers or door hangers on nearby porches is still the easiest way for neighbors to discover your kid’s page.</p>
<ul>
  <li><b>No color ink needed:</b> use the crisp black-and-white flyer in the Flyers tab.</li>
  <li><b>No printer at home?</b> Save the PDF and print 20 copies for a couple dollars at your local public library, Staples, or FedEx Office.</li>
  <li><b>Walk together:</b> 15 minutes around the block, staying outside on porches.</li>
</ul>
<p>Your first 14 days are completely free. After that, a one-time <b>${esc(seasonLabel)} season pass</b> (or <b>${esc(yearLabel)}/year</b>) covers every kid in your family and <b>never auto-renews</b>.</p>
${pageUrl ? `<p><a href="${esc(pageUrl)}" style="color:#a33128;font-weight:700">View live page</a></p>` : ""}
</div>`;

    return { subject, text, html };
  }

  return null;
}
