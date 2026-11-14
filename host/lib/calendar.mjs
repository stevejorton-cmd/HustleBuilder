// Family calendar feed. A job's start is a wall-clock time ("2026-12-02T16:00")
// — the hour the neighbor picked, in the family's own time zone. That zone is
// saved on the account when a parent publishes (from their browser); accounts
// from before that, and anything without one, use America/Chicago, where the
// product started. Duration is one real hour.
//
// The Chicago feed keeps its original shape (TZID + VTIMEZONE). Every other
// zone is written as exact UTC instants, which every calendar app shows at
// the right local hour without needing a time-zone table in the file.

const TZID = "America/Chicago";
export const DEFAULT_TZ = TZID;

export function validTz(value) {
  const tz = String(value || "").trim();
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return "";
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone || ""; }
  catch { return ""; }
}

export function wallIn(ms, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || TZID,
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
  return wallIn(ms, TZID);
}

export function jobInstant(start, tz = TZID) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(start || ""));
  if (!m) return null;
  if (tz && tz !== TZID) {
    // Find the instant whose wall clock in tz reads `start`. Two or three
    // corrections settle it; a wall time skipped by a clock change lands on
    // the nearest real instant.
    const want = Date.parse(m[1] + "T" + m[2] + ":00Z");
    if (Number.isNaN(want)) return null;
    let ms = want;
    for (let i = 0; i < 4; i++) {
      const diff = want - Date.parse(wallIn(ms, tz) + ":00Z");
      if (!diff) break;
      ms += diff;
    }
    return ms;
  }
  for (const off of ["-05:00", "-06:00"]) {
    const ms = Date.parse(m[1] + "T" + m[2] + ":00" + off);
    if (Number.isNaN(ms)) continue;
    if (chicagoWall(ms) === m[1] + "T" + m[2]) return ms;
  }
  const fallback = Date.parse(m[1] + "T" + m[2] + ":00-06:00");
  return Number.isNaN(fallback) ? null : fallback;
}

export function addHourWall(start, tz = TZID) {
  const ms = jobInstant(start, tz);
  if (ms == null) return "";
  return wallIn(ms + 3600000, tz);
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

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function timeLines(start, tz) {
  const local = !tz || tz === TZID;
  const end = addHourWall(start, local ? TZID : tz);
  if (!end) return null;
  const startMs = local ? 0 : jobInstant(start, tz);
  return [
    local ? "DTSTART;TZID=" + TZID + ":" + stamp(start) : "DTSTART:" + utcStamp(startMs),
    local ? "DTEND;TZID=" + TZID + ":" + stamp(end) : "DTEND:" + utcStamp(startMs + 3600000)
  ];
}

function eventLines(job, now, tz) {
  const when = timeLines(job.start, tz);
  if (!when) return [];
  const summary = (job.service || "Job") + " - " + (job.customer || "Customer");
  const bits = [];
  if (job.note) bits.push(String(job.note));
  if (job.amount) bits.push("Price: " + job.amount);
  const lines = [
    "BEGIN:VEVENT",
    "UID:" + job.id + "@hustlebuilder.org",
    "DTSTAMP:" + dtstamp(now),
    ...when,
    "SUMMARY:" + icsEscape(summary),
    "LOCATION:" + icsEscape(job.address || "")
  ];
  if (bits.length) lines.push("DESCRIPTION:" + icsEscape(bits.join("\n")));
  lines.push("END:VEVENT");
  return lines;
}

// "Something else" is a menu label, not a job. The title is the first words
// of the neighbor's note (about 40 characters), or "Custom job" if they
// left the note blank. A named service is kept as they picked it.
export function jobTitle(service, note) {
  const raw = String(service || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!/^something else\b/i.test(raw)) return raw.slice(0, 80) || "Job";
  let text = String(note || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,;:!?\-–—]+/, "")
    .trim();
  if (!text) return "Custom job";
  if (text.length > 40) {
    let cut = text.slice(0, 40);
    const space = cut.lastIndexOf(" ");
    if (space >= 12) cut = cut.slice(0, space);
    text = cut.replace(/[\s.,;:!?\-–—]+$/, "").trim();
  }
  return text || "Custom job";
}

// One-tap title: "Will: Mow a small yard - Riley". The customer's first name
// only. A missing kid name leaves the job and the neighbor.
export function inviteSummary(kid, service, customer) {
  const who = String(customer || "").trim().split(/\s+/)[0] || "Neighbor";
  const job = String(service || "").trim() || "Job";
  const name = String(kid || "").replace(/[\r\n]+/g, " ").trim().slice(0, 40);
  return (name ? name + ": " : "") + job + " - " + who;
}

export const INVITE_ORGANIZER = "bookings@hustlebuilder.org";

// A real invitation, separate from the family feed (that one stays
// METHOD:PUBLISH). REQUEST is tentative so Google adds it for the parent to
// confirm. CANCEL uses the same UID and a higher SEQUENCE so the calendar
// drops that same event.
export function bookingInviteIcs({
  id, start, tz = TZID, now = Date.now(), summary, location = "", description = "",
  attendee, sequence = 0, method = "REQUEST", organizer = INVITE_ORGANIZER
} = {}) {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(String(id || ""))) return "";
  const when = timeLines(start, tz);
  if (!when) return "";
  const kind = method === "CANCEL" ? "CANCEL" : "REQUEST";
  const seq = Math.max(0, Math.floor(Number(sequence) || 0));
  const mail = String(attendee || "").trim();
  const local = !tz || tz === TZID;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hustle Builder//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:" + kind,
    ...(local ? [VTIMEZONE] : ["X-WR-TIMEZONE:" + tz]),
    "BEGIN:VEVENT",
    "UID:" + id + "@hustlebuilder.org",
    "SEQUENCE:" + seq,
    "DTSTAMP:" + dtstamp(now),
    ...when,
    "SUMMARY:" + icsEscape(summary || "Job"),
    "LOCATION:" + icsEscape(location),
    "DESCRIPTION:" + icsEscape(description),
    "ORGANIZER;CN=Hustle Builder:mailto:" + organizer,
    "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:" + mail,
    "STATUS:" + (kind === "CANCEL" ? "CANCELLED" : "TENTATIVE"),
    "CLASS:PRIVATE",
    "END:VEVENT",
    "END:VCALENDAR"
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function jobsToIcs(jobs, now = Date.now(), tz = TZID) {
  const local = !tz || tz === TZID;
  const events = [];
  for (const job of pruneJobs(jobs, now)) {
    if (!job || !/^[A-Za-z0-9_-]{6,80}$/.test(String(job.id || ""))) continue;
    events.push(...eventLines(job, now, tz));
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hustle Builder//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Hustle Jobs",
    ...(local ? [VTIMEZONE] : ["X-WR-TIMEZONE:" + tz]),
    ...events,
    "END:VCALENDAR"
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function gcalTemplate(job, tz = TZID) {
  const end = addHourWall(job && job.start, tz || TZID);
  if (!end) return "";
  const text = (job.service || "Job") + " - " + (job.customer || "");
  const details = [job.note || "", job.amount ? "Price: " + job.amount : ""].filter(Boolean).join("\n");
  return "https://calendar.google.com/calendar/render?action=TEMPLATE&text="
    + encodeURIComponent(text)
    + "&dates=" + stamp(job.start) + "/" + stamp(end)
    + "&details=" + encodeURIComponent(details)
    + "&location=" + encodeURIComponent(job.address || "")
    + (tz && tz !== TZID ? "&ctz=" + encodeURIComponent(tz) : "");
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
