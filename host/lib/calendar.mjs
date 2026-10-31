// Family calendar feed. Times are America/Chicago wall clocks (Lincoln),
// matching the hour the neighbor picked. Duration is one real hour.

const TZID = "America/Chicago";
export const JOB_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Chicago",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0600",
  "TZOFFSETTO:-0500",
  "TZNAME:CDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0600",
  "TZNAME:CST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE"
].join("\r\n");

export function chicagoWall(ms) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZID,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  const hour = p.hour === "24" ? "00" : p.hour;
  return p.year + "-" + p.month + "-" + p.day + "T" + hour + ":" + p.minute;
}

export function jobInstant(start) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(start || ""));
  if (!m) return null;
  for (const off of ["-05:00", "-06:00"]) {
    const ms = Date.parse(m[1] + "T" + m[2] + ":00" + off);
    if (Number.isNaN(ms)) continue;
    if (chicagoWall(ms) === m[1] + "T" + m[2]) return ms;
  }
  const fallback = Date.parse(m[1] + "T" + m[2] + ":00-06:00");
  return Number.isNaN(fallback) ? null : fallback;
}

export function addHourWall(start) {
  const ms = jobInstant(start);
  if (ms == null) return "";
  return chicagoWall(ms + 3600000);
}

export function pruneJobs(jobs, now = Date.now()) {
  const cutoff = now - JOB_KEEP_MS;
  return (Array.isArray(jobs) ? jobs : []).filter((j) => {
    const ms = jobInstant(j && j.start);
    return ms != null && ms >= cutoff;
  });
}

export function icsEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let i = 0;
  let limit = 75;
  while (i < bytes.length) {
    let end = Math.min(bytes.length, i + limit);
    while (end > i && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === i) end = Math.min(bytes.length, i + limit);
    parts.push(bytes.slice(i, end).toString("utf8"));
    i = end;
    limit = 74;
  }
  return parts.join("\r\n ");
}

function stamp(wall) {
  return String(wall || "").replace(/[-:]/g, "") + "00";
}

function dtstamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function eventLines(job, now) {
  const end = addHourWall(job.start);
  if (!end) return [];
  const summary = (job.service || "Job") + " - " + (job.customer || "Customer");
  const bits = [];
  if (job.note) bits.push(String(job.note));
  if (job.amount) bits.push("Price: " + job.amount);
  const lines = [
    "BEGIN:VEVENT",
    "UID:" + job.id + "@hustlebuilder.org",
    "DTSTAMP:" + dtstamp(now),
    "DTSTART;TZID=" + TZID + ":" + stamp(job.start),
    "DTEND;TZID=" + TZID + ":" + stamp(end),
    "SUMMARY:" + icsEscape(summary),
    "LOCATION:" + icsEscape(job.address || "")
  ];
  if (bits.length) lines.push("DESCRIPTION:" + icsEscape(bits.join("\n")));
  lines.push("END:VEVENT");
  return lines;
}

export function jobsToIcs(jobs, now = Date.now()) {
  const events = [];
  for (const job of pruneJobs(jobs, now)) {
    if (!job || !/^[A-Za-z0-9_-]{6,80}$/.test(String(job.id || ""))) continue;
    events.push(...eventLines(job, now));
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hustle Builder//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Hustle Jobs",
    VTIMEZONE,
    ...events,
    "END:VCALENDAR"
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function gcalTemplate(job) {
  const end = addHourWall(job && job.start);
  if (!end) return "";
  const text = (job.service || "Job") + " - " + (job.customer || "");
  const details = [job.note || "", job.amount ? "Price: " + job.amount : ""].filter(Boolean).join("\n");
  return "https://calendar.google.com/calendar/render?action=TEMPLATE&text="
    + encodeURIComponent(text)
    + "&dates=" + stamp(job.start) + "/" + stamp(end)
    + "&details=" + encodeURIComponent(details)
    + "&location=" + encodeURIComponent(job.address || "");
}

export function feedLinks(origin, token) {
  const base = String(origin || "").replace(/\/$/, "");
  const httpsUrl = base + "/api/cal/" + token + ".ics";
  let host = "";
  try { host = new URL(base).host; } catch { host = base.replace(/^https?:\/\//, ""); }
  const webcal = "webcal://" + host + "/api/cal/" + token + ".ics";
  const google = "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(webcal);
  return { calUrl: httpsUrl, calWebcal: webcal, calGoogle: google };
}
