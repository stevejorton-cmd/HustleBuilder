import test from 'node:test';
import assert from 'node:assert/strict';
import {recurrenceHint,recurrencePlan,MAX_REPEAT_VISITS,MAX_AWAY_VISITS} from '../host/lib/recurrence.mjs';
import {jobInstant,wallIn} from '../host/lib/calendar.mjs';
const now=Date.parse('2026-11-22T18:00:00Z');
const row=(freq='Every week',start='2026-11-23T16:30',fields={})=>({invite:{start,tz:'America/Chicago'},fields:{freq,...fields}});
const plan=(value,options={})=>recurrencePlan(value,{now,...options});

test('only explicit supported preferences offer a repeating proposal',()=>{
  for(const freq of ['Every week','Once a week','Weekly poop scoop',' WEEKLY  '])assert.equal(recurrenceHint(row(freq)).kind,'weekly',freq);
  assert.equal(recurrenceHint(row('Every other week')).kind,'biweekly');
  assert.equal(recurrenceHint(row('While I’m away')).kind,'away');
  for(const freq of ['Just this time','Every snowfall this winter','A few days a week','Every day','Weekdays','Maybe every week','Weekly cleaning when needed','',null])assert.equal(plan(row(freq)),null,String(freq));
  assert.equal(recurrenceHint(null),null);assert.equal(plan(undefined),null);
});

test('weekly and biweekly proposals include the original visit and require explicit bounded counts',()=>{
  assert.deepEqual(plan(row(),{count:4}).starts,['2026-11-23T16:30','2026-11-30T16:30','2026-12-07T16:30','2026-12-14T16:30']);
  const two=plan(row('Every other week'),{count:3});assert.equal(two.kind,'biweekly');assert.deepEqual(two.starts,['2026-11-23T16:30','2026-12-07T16:30','2026-12-21T16:30']);
  for(const count of [undefined,null,0,1,9,-1,2.5,'4',Infinity]){const p=plan(row(),{count});assert.equal(p.error,'count',String(count));assert.deepEqual(p.starts,[]);}
  assert.equal(plan(row(),{count:MAX_REPEAT_VISITS}).count,MAX_REPEAT_VISITS);
});

test('away proposals cover exactly the agreed inclusive range and preserve the chosen hour',()=>{
  const p=plan(row("While I'm away",'2026-11-26T17:00',{awayFrom:'2026-11-26',awayTo:'2026-12-01'}));
  assert.equal(p.kind,'away');assert.equal(p.count,6);assert.equal(p.starts[0],'2026-11-26T17:00');assert.equal(p.starts.at(-1),'2026-12-01T17:00');
  assert.equal(plan(row("While I'm away",'2026-11-23T16:00',{awayFrom:'2026-11-23',awayTo:'2026-12-06'})).count,MAX_AWAY_VISITS);
  for(const fields of [{awayFrom:'2026-11-23',awayTo:'2026-12-07'},{awayFrom:'2026-11-23',awayTo:'2026-11-23'},{awayFrom:'2026-11-24',awayTo:'2026-11-23'},{awayFrom:'2026-11-24',awayTo:'2026-11-26'}])assert.equal(plan(row("While I'm away",'2026-11-23T16:00',fields)).error,'range');
  assert.equal(plan(row("While I'm away",'2026-11-23T16:00',{awayFrom:'2026-02-31',awayTo:'2026-03-03'})).error,'date');
});

test('weekly visits keep the same local time across daylight-saving changes',()=>{
  for(const tz of ['America/Chicago','America/New_York']){
    const p=plan(row('Every week','2027-03-07T16:30'),{now:Date.parse('2027-03-01T12:00:00Z'),tz,count:3});
    assert.ok(!p.error,p.message);assert.deepEqual(p.starts,['2027-03-07T16:30','2027-03-14T16:30','2027-03-21T16:30']);
    const ms=p.starts.map(s=>jobInstant(s,tz));assert.equal((ms[1]-ms[0])/3600000,167);assert.equal((ms[2]-ms[1])/3600000,168);
    for(let i=0;i<ms.length;i++)assert.equal(wallIn(ms[i],tz),p.starts[i]);
  }
});

test('invalid dates, skipped DST wall times and past starts cannot create partial schedules',()=>{
  for(const start of ['2026-11-22T11:00','2026-11-21T16:00'])assert.equal(plan(row('Every week',start),{count:2}).error,'future');
  for(const start of ['bad','2026-02-31T12:00','2026-11-23T24:00','2026-11-23T16:61'])assert.equal(plan(row('Every week',start),{count:2}).error,'start',start);
  for(const tz of ['America/Chicago','America/New_York']){
    const opts={now:Date.parse('2027-03-01T12:00:00Z'),tz,count:2};
    assert.equal(plan(row('Every week','2027-03-14T02:30'),opts).error,'start');
    const skipped=plan(row('Every week','2027-03-07T02:30'),opts);assert.equal(skipped.error,'date');assert.deepEqual(skipped.starts,[]);
  }
});

test('all visits must fit the same 120-day horizon, including away ranges',()=>{
  const inside=plan(row('Every week','2027-03-15T16:30'),{count:2});assert.equal(inside.starts.at(-1),'2027-03-22T16:30');
  const outside=plan(row('Every week','2027-03-16T16:30'),{count:2});assert.equal(outside.error,'horizon');assert.deepEqual(outside.starts,[]);
  const away=plan(row("While I'm away",'2027-03-21T16:00',{awayFrom:'2027-03-21',awayTo:'2027-03-23'}));assert.equal(away.error,'horizon');
});

test('planning is pure, accepts legacy dated rows and refuses invalid clock or timezone',()=>{
  const original=row('Every other week'),before=JSON.stringify(original);plan(original,{count:3});assert.equal(JSON.stringify(original),before);
  assert.equal(plan({calJob:{start:'2026-11-23T16:30'},fields:{freq:'Every week'}},{count:2}).starts[0],'2026-11-23T16:30');
  assert.equal(plan(row(),{count:2,tz:'Mars/Olympus'}).error,'timezone');assert.equal(plan(row(),{count:2,now:NaN}).error,'clock');
  assert.equal(recurrenceHint(row()).defaultCount,4);assert.equal(recurrenceHint(row()).requiresCount,true);assert.equal(recurrenceHint(row("While I'm away")).requiresCount,false);
});
