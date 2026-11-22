import test from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import {addEventIcs, bookingInviteIcs, jobsToIcs} from '../host/lib/calendar.mjs';

const booking = {
  id: 'bcalendar123', start: '2026-12-02T16:00',
  now: Date.parse('2026-11-22T18:00:00Z'),
  summary: 'Taylor: Yard cleanup - Steve',
  attendee: 'neighbor+test@example.com', location: '123 Test St',
  description: 'Manage booking: https://hustlebuilder.org/api/cancel/abcdef123456',
  url: 'https://hustlebuilder.org/api/cancel/abcdef123456?from=calendar&view=booking'
};
function parse(ics) {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  return {calendar, event: calendar.getFirstSubcomponent('vevent')};
}

test('pending, confirmed, rescheduled and cancelled invitations update one event', () => {
  const lifecycle = [
    {sequence: 0, status: 'TENTATIVE'},
    {sequence: 1, confirmed: true, status: 'CONFIRMED'},
    {sequence: 2, confirmed: true, start: '2026-12-03T17:00', status: 'CONFIRMED'},
    {sequence: 3, method: 'CANCEL', start: '2026-12-03T17:00', status: 'CANCELLED'}
  ];
  for (const state of lifecycle) {
    const {calendar, event} = parse(bookingInviteIcs({...booking, ...state}));
    assert.equal(calendar.getFirstPropertyValue('method'), state.method || 'REQUEST');
    assert.equal(event.getFirstPropertyValue('uid'), booking.id + '@hustlebuilder.org');
    assert.equal(event.getFirstPropertyValue('sequence'), state.sequence);
    assert.equal(event.getFirstPropertyValue('status'), state.status);
    assert.equal(event.getFirstPropertyValue('url'), booking.url);
    assert.equal(event.getFirstPropertyValue('dtstart').toString(), (state.start || booking.start) + ':00');
    const attendee = event.getFirstProperty('attendee');
    assert.equal(attendee.getFirstValue(), 'mailto:' + booking.attendee);
    assert.equal(attendee.getParameter('partstat'), 'NEEDS-ACTION');
    assert.equal(attendee.getParameter('rsvp'), state.method === 'CANCEL' ? 'FALSE' : 'TRUE');
  }
});

test('calendar text cannot inject another property and Unicode lines stay valid', () => {
  const summary = 'Rake leaves, sweep; clean\\tidy\r\nATTENDEE:mailto:intruder@example.com 🍂'.repeat(3);
  const text = bookingInviteIcs({...booking, summary, description: summary});
  const {event} = parse(text);
  assert.equal(event.getAllProperties('attendee').length, 1);
  assert.equal(event.getFirstPropertyValue('summary'), summary.replace(/\r\n/g, '\n'));
  for (const line of text.trimEnd().split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
});

test('invitation addresses and management URLs reject property injection', () => {
  for (const key of ['attendee', 'organizer']) {
    assert.equal(bookingInviteIcs({...booking, [key]: 'parent@example.com\r\nATTENDEE:mailto:intruder@example.com'}), '');
  }
  for (const url of ['javascript:alert(1)', 'https://a.test/\r\nATTENDEE:mailto:bad@example.com', 'https://user:secret@a.test/']) {
    const {event} = parse(bookingInviteIcs({...booking, url}));
    assert.equal(event.getFirstPropertyValue('url'), null);
    assert.equal(event.getAllProperties('attendee').length, 1);
  }
});

test('standalone event copies can link back to customer management without organizer details', () => {
  const {calendar, event} = parse(addEventIcs({...booking, confirmed: true, sequence: 4}));
  assert.equal(calendar.getFirstPropertyValue('method'), 'PUBLISH');
  assert.equal(event.getFirstPropertyValue('url'), booking.url);
  assert.equal(event.getFirstPropertyValue('status'), 'CONFIRMED');
  assert.equal(event.getFirstPropertyValue('organizer'), null);
  assert.equal(event.getFirstPropertyValue('attendee'), null);
});

test('family feed includes only a valid management URL in description and URL property', () => {
  const job = {
    id: booking.id, start: booking.start, source: 'book',
    status: 'confirmed', sequence: 2, service: 'Yard cleanup', customer: 'Steve',
    manageUrl: 'https://hustlebuilder.org/api/job/abcdef123456'
  };
  const {event} = parse(jobsToIcs([job], booking.now));
  assert.equal(event.getFirstPropertyValue('url'), job.manageUrl);
  assert.equal(event.getFirstPropertyValue('description'), 'Manage booking: ' + job.manageUrl);
  assert.equal(event.getFirstPropertyValue('status'), 'CONFIRMED');
  const invalid = parse(jobsToIcs([{...job, manageUrl: 'javascript:alert(1)'}], booking.now)).event;
  assert.equal(invalid.getFirstPropertyValue('url'), null);
  assert.equal(invalid.getFirstPropertyValue('description'), null);
});
