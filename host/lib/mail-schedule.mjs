const chicagoClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', hour: '2-digit', hourCycle: 'h23'
});

// Only background retry scans obey this window. Mail from a person’s
// request and new notices from the daily renewal job send immediately.
export function mailRetriesOpen(now = Date.now()) {
  const parts = chicagoClock.formatToParts(now);
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  return hour >= 9 && hour < 22;
}
