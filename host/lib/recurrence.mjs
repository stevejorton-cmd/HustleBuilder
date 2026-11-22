import {DEFAULT_TZ,jobInstant,validTz,wallIn} from './calendar.mjs';

// These are proposals for explicit parent approval, not automatic bookings.
// Each approved start becomes its own independently managed appointment.
export const MAX_REPEAT_VISITS=8;
export const MAX_AWAY_VISITS=14;
export const RECURRENCE_HORIZON_DAYS=120;
const DAY_MS=864e5;

function frequency(row){
  return String(row?.fields?.freq||'').trim().toLowerCase().replace(/[’‘]/g,"'").replace(/\s+/g,' ');
}
export function recurrenceHint(row){
  const freq=frequency(row);
  if(/^(?:every week|once a week|weekly(?: poop scoop)?)$/.test(freq))return {kind:'weekly',label:'Weekly visits',maxCount:MAX_REPEAT_VISITS,defaultCount:4,requiresCount:true};
  if(/^(?:every other week|biweekly|bi-weekly)$/.test(freq))return {kind:'biweekly',label:'Visits every other week',maxCount:MAX_REPEAT_VISITS,defaultCount:4,requiresCount:true};
  if(/^while i(?:'m| am) away$/.test(freq))return {kind:'away',label:'Daily visits during the away dates',maxCount:MAX_AWAY_VISITS,requiresCount:false};
  // Snowfall, weekdays, and other preferences need an agreed schedule.
  return null;
}
function dateInstant(date){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;
  const instant=Date.parse(date+'T00:00:00Z');
  return Number.isFinite(instant)&&new Date(instant).toISOString().slice(0,10)===date?instant:null;
}
function addDays(date,days){
  const instant=dateInstant(date);
  return instant==null?'':new Date(instant+days*DAY_MS).toISOString().slice(0,10);
}
function strictInstant(start,tz){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start))return null;
  const instant=jobInstant(start,tz);
  return instant!=null&&Number.isFinite(instant)&&wallIn(instant,tz)===start?instant:null;
}

export function recurrencePlan(row,options={}){
  const hint=recurrenceHint(row);
  if(!hint)return null;
  const fail=(error,message)=>({kind:hint.kind,label:hint.label,starts:[],error,message});
  const now=Number(options?.now??Date.now());
  if(!Number.isFinite(now)||!Number.isFinite(new Date(now).getTime()))return fail('clock','The current date could not be checked. Try again.');
  const rawZone=options?.tz??row?.invite?.tz??row?.tz??DEFAULT_TZ;
  const tz=validTz(rawZone);
  if(!tz)return fail('timezone','Choose a valid family time zone before approving repeating visits.');
  const start=String(row?.invite?.start||row?.calJob?.start||row?.start||'').trim();
  const firstInstant=strictInstant(start,tz);
  if(firstInstant==null)return fail('start','The first appointment needs a valid date and time before repeating visits can be approved.');
  if(firstInstant<=now)return fail('future','The first appointment must still be in the future. Agree on a new first appointment before approving repeating visits.');
  const firstDay=start.slice(0,10),time=start.slice(11),starts=[];
  const latestDay=addDays(wallIn(now,tz).slice(0,10),RECURRENCE_HORIZON_DAYS);
  if(hint.kind==='away'){
    const from=String(row?.fields?.awayFrom||'').trim(),to=String(row?.fields?.awayTo||'').trim();
    const fromInstant=dateInstant(from),toInstant=dateInstant(to);
    if(fromInstant==null||toInstant==null)return fail('date','Choose valid first and last away dates before approving daily visits.');
    const count=(toInstant-fromInstant)/DAY_MS+1;
    if(count<2||count>MAX_AWAY_VISITS)return fail('range','Daily visits can cover 2 to '+MAX_AWAY_VISITS+' days at a time. Agree on a shorter away range if needed.');
    if(firstDay!==from)return fail('range','The selected appointment must be on the first away date. Agree on the first visit before approving the full range.');
    for(let i=0;i<count;i++)starts.push(addDays(firstDay,i)+'T'+time);
  }else{
    const count=options?.count;
    if(!Number.isInteger(count)||count<2||count>MAX_REPEAT_VISITS)return fail('count','Choose 2 to '+MAX_REPEAT_VISITS+' visits before approving the schedule.');
    const step=hint.kind==='weekly'?7:14;
    for(let i=0;i<count;i++)starts.push(addDays(firstDay,i*step)+'T'+time);
  }
  for(const next of starts){
    if(next.slice(0,10)>latestDay)return fail('horizon','All visits must be within the next '+RECURRENCE_HORIZON_DAYS+' days. Choose fewer visits or a shorter away range.');
    const instant=strictInstant(next,tz);
    if(instant==null)return fail('date','A proposed visit falls at a date or local time that does not exist. Agree on another time before approving the schedule.');
    if(instant<=now)return fail('future','Every visit must still be in the future. Agree on another first appointment before approving the schedule.');
  }
  return {kind:hint.kind,label:hint.label,starts,count:starts.length};
}
