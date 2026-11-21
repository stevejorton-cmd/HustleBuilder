import {DEFAULT_TZ,jobInstant} from './calendar.mjs';

// Age a booking from the later of its arrival and its scheduled work. An
// advance booking must not lose its action/cancel links before the job.
export function bookingExpiry(row,days=30){
  if(!row)return 0;
  const tz=row.invite?.tz||row.tz||DEFAULT_TZ;
  const dates=[Date.parse(row.createdAt||'')];
  for(const start of [row.invite?.start,row.calJob?.start,row.start]){
    if(start){const instant=jobInstant(start,tz);if(instant!=null)dates.push(instant);}
  }
  const lastDay=row.fields?.awayTo;
  if(/^\d{4}-\d{2}-\d{2}$/.test(lastDay||'')){
    const instant=jobInstant(lastDay+'T23:59',tz);if(instant!=null)dates.push(instant);
  }
  const valid=dates.filter(Number.isFinite);
  return valid.length?Math.max(...valid)+days*864e5:0;
}
