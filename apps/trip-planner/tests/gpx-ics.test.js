'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

const { buildGpx, parseIcsToProposals } = L;

// The file the browser hands the parser: RFC 5545 wants CRLF, and the folding
// rule only exists on CRLF, so every fixture here is built with them.
const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];

// ---------- GPX export ----------

test('buildGpx writes GPX 1.1 with one waypoint per stop in visit order', () => {
  const gpx = buildGpx([
    { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
    { name: 'Kyoto', lat: 35.0116, lon: 135.7681 },
    { name: 'Osaka', lat: 34.6937, lon: 135.5023 },
  ]);
  assert.match(gpx, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  assert.match(gpx, /<gpx version="1\.1" creator="[^"]+" xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1">/);
  assert.match(gpx, /<wpt lat="35\.676200" lon="139\.650300">\n\s*<name>Tokyo<\/name>/);
  // Order is the itinerary, not the alphabet or the geography: a GPS app draws
  // the legs in the order the waypoints appear.
  assert.deepEqual(gpx.match(/<name>([^<]+)<\/name>/g), ['<name>Tokyo</name>', '<name>Kyoto</name>', '<name>Osaka</name>']);
  assert.ok(gpx.trimEnd().endsWith('</gpx>'));
});

test('buildGpx collapses only ADJACENT repeats of a place, like the map does', () => {
  // Three items in Tokyo, then Kyoto, then back to Tokyo. Coming back later is
  // a leg of the route and must stay a waypoint; two things in a row in the
  // same city are one place, not two.
  const gpx = buildGpx([
    { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
    { name: 'tokyo', lat: 35.6762, lon: 139.6503 },
    { name: 'Kyoto', lat: 35.0116, lon: 135.7681 },
    { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  ]);
  assert.deepEqual(gpx.match(/<name>([^<]+)<\/name>/g), ['<name>Tokyo</name>', '<name>Kyoto</name>', '<name>Tokyo</name>']);
});

test('buildGpx omits a stop with no coordinate rather than sending it to 0,0', () => {
  const gpx = buildGpx([
    { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
    { name: 'Somewhere nobody geocoded' },
    { name: 'Bad numbers', lat: 'x', lon: null },
    { name: 'Off the globe', lat: 91, lon: 0 },
    { name: 'Kyoto', lat: 35.0116, lon: 135.7681 },
  ]);
  assert.deepEqual(gpx.match(/<name>([^<]+)<\/name>/g), ['<name>Tokyo</name>', '<name>Kyoto</name>']);
  assert.ok(!gpx.includes('0.000000'));
  assert.ok(!gpx.includes('Somewhere nobody geocoded'));
});

test('buildGpx does not leave the same place twice in a row after dropping an unlocated stop', () => {
  const gpx = buildGpx([
    { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
    { name: 'Nowhere' },
    { name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  ]);
  assert.deepEqual(gpx.match(/<name>([^<]+)<\/name>/g), ['<name>Tokyo</name>']);
});

test('buildGpx XML-escapes place names so an ampersand cannot break the file', () => {
  const gpx = buildGpx([
    { name: 'Bar & Grill <"main"> \'the spot\'', lat: 1, lon: 2 },
    { name: 'Kyoto', lat: 35.0116, lon: 135.7681 },
  ]);
  assert.match(gpx, /<name>Bar &amp; Grill &lt;&quot;main&quot;&gt; &apos;the spot&apos;<\/name>/);
  // no bare ampersand anywhere: that alone makes the whole file unparseable,
  // and "Bar & Grill" is an ordinary thing for a stop to be called
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(gpx));
});

test('buildGpx prints decimals, never exponent notation (invalid in GPX)', () => {
  const gpx = buildGpx([
    { name: 'Near zero', lat: 0.0000001, lon: -0.0000002 },
    { name: 'Kyoto', lat: 35.0116, lon: 135.7681 },
  ]);
  assert.ok(!/e-/i.test(gpx));
  assert.match(gpx, /<wpt lat="0\.000000" lon="-0\.000000">/);
});

test('buildGpx with nothing to draw is still a valid, empty GPX document', () => {
  const gpx = buildGpx([]);
  assert.match(gpx, /<gpx version="1\.1"/);
  assert.ok(!gpx.includes('<wpt'));
  assert.ok(gpx.trimEnd().endsWith('</gpx>'));
});

// ---------- calendar import (.ics) ----------

test('parseIcsToProposals reads every field a card shows off a timed event', () => {
  const res = parseIcsToProposals(ics(...vevent(
    'SUMMARY:Louvre tickets',
    'LOCATION:Paris',
    'DTSTART:20270112T093000',
    'DTEND:20270112T113000',
    'DESCRIPTION:Entry via the Pyramid'
  )));
  assert.equal(res.proposals.length, 1);
  assert.deepEqual(res.proposals[0].item, {
    type: 'activity',
    title: 'Louvre tickets',
    location: 'Paris',
    startDate: '2027-01-12',
    startTime: '09:30',
    // same day, so no end DATE to show, but the end TIME is real information
    endDate: '',
    endTime: '11:30',
    details: 'Entry via the Pyramid',
  });
  assert.deepEqual(res.stats, { events: 1, read: 1, skipped: 0, recurring: 0 });
});

test('parseIcsToProposals turns N events into N proposals', () => {
  const res = parseIcsToProposals(ics(
    ...vevent('SUMMARY:One', 'DTSTART:20270112T090000'),
    ...vevent('SUMMARY:Two', 'DTSTART:20270113T090000')
  ));
  assert.deepEqual(res.proposals.map(p => p.item.title), ['One', 'Two']);
  assert.equal(res.stats.read, 2);
});

test('parseIcsToProposals takes the wall clock as written for Z and TZID stamps', () => {
  // The app stores no time zone, so converting would shift the event by an
  // amount nothing in the app could name back. 09:00 in the file is 09:00.
  const res = parseIcsToProposals(ics(
    ...vevent('SUMMARY:Zulu', 'DTSTART:20270112T090000Z', 'DTEND:20270112T100000Z'),
    ...vevent('SUMMARY:Zoned', 'DTSTART;TZID=Europe/Paris:20270112T140000')
  ));
  assert.equal(res.proposals[0].item.startTime, '09:00');
  assert.equal(res.proposals[0].item.endTime, '10:00');
  assert.equal(res.proposals[1].item.startTime, '14:00');
});

test('parseIcsToProposals reads an all-day DTEND as EXCLUSIVE', () => {
  // Calendar apps write a 3-day event as Mar 1 -> Mar 4. The app's own end date
  // is the last day the thing is happening, so the import is DTEND minus a day;
  // a one-day event keeps an empty end date rather than repeating its start.
  const res = parseIcsToProposals(ics(
    ...vevent('SUMMARY:Conference', 'DTSTART;VALUE=DATE:20270301', 'DTEND;VALUE=DATE:20270304'),
    ...vevent('SUMMARY:Day pass', 'DTSTART;VALUE=DATE:20270310', 'DTEND;VALUE=DATE:20270311')
  ));
  assert.equal(res.proposals[0].item.startDate, '2027-03-01');
  assert.equal(res.proposals[0].item.endDate, '2027-03-03');
  assert.equal(res.proposals[0].item.startTime, '');
  assert.equal(res.proposals[1].item.startDate, '2027-03-10');
  assert.equal(res.proposals[1].item.endDate, '');
});

test('parseIcsToProposals keeps an overnight timed event spanning both days', () => {
  const res = parseIcsToProposals(ics(...vevent(
    'SUMMARY:Night train', 'DTSTART:20270112T233000', 'DTEND:20270113T061500'
  )));
  assert.equal(res.proposals[0].item.startDate, '2027-01-12');
  assert.equal(res.proposals[0].item.endDate, '2027-01-13');
  assert.equal(res.proposals[0].item.endTime, '06:15');
});

test('parseIcsToProposals unfolds RFC 5545 continuation lines', () => {
  // A long SUMMARY is split by the exporter at 75 octets and continued after a
  // CRLF + one space, and that space is the fold marker, not content. Without
  // unfolding, the title loses everything past the fold.
  const res = parseIcsToProposals(ics(
    'BEGIN:VEVENT',
    'SUMMARY:Dinner at the restaurant with the extremely long name in the ninth ',
    ' arrondissement',
    'DTSTART:20270112T200000',
    'DESCRIPTION:Table for two under Nikita\\, ring the bell twice',
    'END:VEVENT'
  ));
  assert.equal(res.proposals[0].item.title,
    'Dinner at the restaurant with the extremely long name in the ninth arrondissement');
  assert.equal(res.proposals[0].item.details, 'Table for two under Nikita, ring the bell twice');
});

test('parseIcsToProposals also unfolds a tab continuation', () => {
  const res = parseIcsToProposals(ics('BEGIN:VEVENT', 'SUMMARY:Split', '\tover a tab', 'DTSTART:20270112', 'END:VEVENT'));
  assert.equal(res.proposals[0].item.title, 'Splitover a tab');
});

test('parseIcsToProposals unescapes commas, semicolons, newlines and backslashes', () => {
  const res = parseIcsToProposals(ics(...vevent(
    'SUMMARY:Pack\\; check\\, twice',
    'LOCATION:Tokyo\\, Japan',
    'DTSTART:20270112',
    'DESCRIPTION:line1\\nline2\\NLINE3 \\\\ done'
  )));
  const item = res.proposals[0].item;
  assert.equal(item.title, 'Pack; check, twice');
  assert.equal(item.location, 'Tokyo, Japan');
  assert.equal(item.details, 'line1\nline2\nLINE3 \\ done');
});

test('parseIcsToProposals skips an event whose start date cannot be read and counts it', () => {
  // The count is the point: silently importing 2 of 3 events would leave a
  // traveller planning around an itinerary with a hole they never saw.
  const res = parseIcsToProposals(ics(
    ...vevent('SUMMARY:Good', 'DTSTART:20270112T090000'),
    ...vevent('SUMMARY:No start at all'),
    ...vevent('SUMMARY:Junk start', 'DTSTART:not-a-date'),
    ...vevent('SUMMARY:Impossible date', 'DTSTART;VALUE=DATE:20270230'),
    ...vevent('SUMMARY:Impossible time', 'DTSTART:20270112T256000')
  ));
  assert.deepEqual(res.proposals.map(p => p.item.title), ['Good']);
  assert.deepEqual(res.stats, { events: 5, read: 1, skipped: 4, recurring: 0 });
});

test('parseIcsToProposals ignores a VALARM nested inside the event', () => {
  // The alarm's own SUMMARY and DESCRIPTION went into the same first-wins
  // property map as the event's, so "Reminder: 30 minutes before" arrived as
  // the trip item's details and an alarm could rename the event.
  const res = parseIcsToProposals(ics(
    'BEGIN:VEVENT',
    'DTSTART:20270112T093000',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'SUMMARY:Reminder',
    'DESCRIPTION:Reminder\\, 30 minutes before',
    'TRIGGER:-PT30M',
    'END:VALARM',
    'SUMMARY:Louvre tickets',
    'DESCRIPTION:Entry via the Pyramid',
    'END:VEVENT'
  ));
  assert.equal(res.proposals[0].item.title, 'Louvre tickets');
  assert.equal(res.proposals[0].item.details, 'Entry via the Pyramid');
  assert.deepEqual(res.stats, { events: 1, read: 1, skipped: 0, recurring: 0 });
});

test('parseIcsToProposals counts an event the file cuts off mid-way', () => {
  // Reporting {events: 0} told the traveller their calendar was empty and sent
  // them looking for a fault in a file that is simply truncated.
  const res = parseIcsToProposals('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Cut off\r\nDTSTART:20270112T090000');
  assert.deepEqual(res.proposals, []);
  assert.deepEqual(res.stats, { events: 1, read: 0, skipped: 1, recurring: 0 });
});

test('parseIcsToProposals reads a TZID whose value holds an unquoted colon', () => {
  // Outlook writes "TZID=GMT+05:00" without quotes, so splitting on the first
  // colon left a value of "00:20270112T090000" and the event was skipped.
  const res = parseIcsToProposals(ics(...vevent(
    'SUMMARY:Zoned',
    'DTSTART;TZID=GMT+05:00:20270112T090000',
    'DTEND;TZID=GMT+05:00:20270112T110000'
  )));
  assert.equal(res.stats.read, 1);
  assert.equal(res.proposals[0].item.startDate, '2027-01-12');
  assert.equal(res.proposals[0].item.startTime, '09:00');
  assert.equal(res.proposals[0].item.endTime, '11:00');
  // the quoted form is the legal one and still splits in the right place
  const quoted = parseIcsToProposals(ics(...vevent('SUMMARY:Quoted', 'DTSTART;TZID="GMT+05:00":20270112T090000')));
  assert.equal(quoted.proposals[0].item.startTime, '09:00');
});

test('parseIcsToProposals reads a DURATION when the file prints no DTEND', () => {
  const res = parseIcsToProposals(ics(
    ...vevent('SUMMARY:Tour', 'DTSTART:20270112T090000', 'DURATION:PT2H'),
    ...vevent('SUMMARY:Night', 'DTSTART:20270112T230000', 'DURATION:PT1H30M'),
    ...vevent('SUMMARY:Festival', 'DTSTART;VALUE=DATE:20270301', 'DURATION:P3D'),
    ...vevent('SUMMARY:Junk', 'DTSTART:20270112T090000', 'DURATION:whenever')
  ));
  assert.equal(res.proposals[0].item.endTime, '11:00');
  assert.equal(res.proposals[0].item.endDate, '');
  // past midnight the end DATE is real information, exactly as a DTEND would be
  assert.equal(res.proposals[1].item.endDate, '2027-01-13');
  assert.equal(res.proposals[1].item.endTime, '00:30');
  // an all-day duration stands in for an EXCLUSIVE DTEND, so 3 days ends on the 3rd
  assert.equal(res.proposals[2].item.endDate, '2027-03-03');
  // a duration nobody can read costs the end, never the event
  assert.equal(res.proposals[3].item.startDate, '2027-01-12');
  assert.equal(res.proposals[3].item.endDate, '');
  assert.equal(res.proposals[3].item.endTime, '');
});

test('parseIcsToProposals imports a repeating event once, on its first date', () => {
  // DTSTART is the first occurrence. Expanding an RRULE would drop 52 copies of
  // a standing meeting into a two-week trip; the flag is what lets the dialog
  // say so out loud instead.
  const res = parseIcsToProposals(ics(...vevent(
    'SUMMARY:Weekly standup',
    'DTSTART:20270112T090000',
    'RRULE:FREQ=WEEKLY;COUNT=52'
  )));
  assert.equal(res.proposals.length, 1);
  assert.equal(res.proposals[0].item.startDate, '2027-01-12');
  assert.equal(res.proposals[0].recurring, true);
  assert.equal(res.stats.recurring, 1);
});

test('parseIcsToProposals gives a title-less event a placeholder rather than an invalid card', () => {
  // An add with no title fails validateTripAction, which would render as an
  // unexplained "Cannot apply" card for an event the file described fine.
  const res = parseIcsToProposals(ics(...vevent('DTSTART:20270112', 'LOCATION:Kyoto')));
  assert.equal(res.proposals[0].item.title, 'Calendar event');
});

test('parseIcsToProposals ignores calendar-level properties and non-event blocks', () => {
  const res = parseIcsToProposals([
    'BEGIN:VCALENDAR', 'PRODID:-//Test//EN', 'VERSION:2.0',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Paris', 'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'END:DAYLIGHT', 'END:VTIMEZONE',
    ...vevent('SUMMARY:Real event', 'DTSTART:20270112T090000'),
    'END:VCALENDAR',
  ].join('\r\n'));
  assert.deepEqual(res.proposals.map(p => p.item.title), ['Real event']);
  assert.equal(res.stats.events, 1);
});

test('parseIcsToProposals reads a bare-LF file (plenty of exporters write them)', () => {
  const res = parseIcsToProposals('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:LF only\nDTSTART:20270112\nEND:VEVENT\nEND:VCALENDAR\n');
  assert.equal(res.proposals.length, 1);
  assert.equal(res.proposals[0].item.title, 'LF only');
});

test('parseIcsToProposals reports nothing for a calendar with no events', () => {
  const res = parseIcsToProposals(ics('PRODID:-//Test//EN'));
  assert.deepEqual(res.proposals, []);
  assert.deepEqual(res.stats, { events: 0, read: 0, skipped: 0, recurring: 0 });
});

test('parseIcsToProposals proposes types the item validator accepts', () => {
  // The proposals go straight into the same add pipeline the PDF reader uses,
  // so a type it rejects would turn every card into "Cannot apply".
  const res = parseIcsToProposals(ics(...vevent('SUMMARY:Anything', 'DTSTART:20270112')));
  const check = L.validateTripAction({ op: 'add', item: res.proposals[0].item, source: 'document' }, { items: [] });
  assert.equal(check.ok, true);
});

// Owner-reported: text copied out of a chat or email arrives with every line
// uniformly indented, and RFC 5545 unfolding then glues the whole paste into
// one line (leading whitespace means continuation), so a good calendar read
// as "no events". The parser retries once with the common indent stripped.
test('parseIcsToProposals: uniformly indented paste still parses', () => {
  const lines = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Louvre tickets',
    'DTSTART:20270112T093000Z', 'END:VEVENT', 'END:VCALENDAR'];
  for (const indent of ['    ', '\t', '  \t ']) {
    const r = parseIcsToProposals(lines.map(l => indent + l).join('\n'));
    assert.equal(r.stats.read, 1, `indent ${JSON.stringify(indent)}`);
    assert.equal(r.proposals[0].item.title, 'Louvre tickets');
  }
});

test('parseIcsToProposals: dedent retry never breaks genuine folding', () => {
  // A real fold indents ONLY continuation lines, so there is no common
  // indent and the strict parse already succeeds; the retry must not run.
  const folded = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Louvre\n  tickets and more\n'
    + 'DTSTART:20270112T093000Z\nEND:VEVENT\nEND:VCALENDAR';
  const r = parseIcsToProposals(folded);
  assert.equal(r.stats.read, 1);
  assert.equal(r.proposals[0].item.title, 'Louvre tickets and more');
});

test('parseIcsToProposals: a truly empty calendar still reports zero events', () => {
  const r = parseIcsToProposals('    BEGIN:VCALENDAR\n    END:VCALENDAR');
  assert.equal(r.stats.events, 0);
  assert.equal(r.stats.read, 0);
});

// ---------- .ics export: booking deadlines and DTSTART/DTEND ordering ----------
// buildIcs is the only surface here that WRITES a calendar. Two things are
// pinned: an item still waiting to be booked carries its Book-by date into the
// calendar as something that actually notifies, and every VEVENT it writes
// obeys RFC 5545 3.8.2.2 (DTEND never earlier than DTSTART), which strict
// clients enforce by dropping the event outright.

const icsItem = (over = {}) => ({
  id: over.id || 'x1', type: 'activity', title: 'Thing', location: '',
  status: 'booked', startDate: '2027-06-08', startTime: '', ...over,
});
const icsTrip = (items, name) => ({ id: 't1', name: name || 'Croatia', currency: 'USD', items });
const STAMP = new Date('2027-01-02T03:04:05.678Z');
// Every VEVENT block in a generated calendar, unfolded lines kept as written.
const veventsOf = out => out.split('\r\n').reduce((acc, line) => {
  if (line === 'BEGIN:VEVENT') acc.push([]);
  else if (line === 'END:VEVENT') { /* block closed */ }
  else if (acc.length && line !== 'END:VCALENDAR') acc[acc.length - 1].push(line);
  return acc;
}, []);
const propOf = (block, name) => block.find(l => l === name || l.startsWith(name + ':') || l.startsWith(name + ';'));

test('buildIcs writes a booking-deadline entry for a to-book item carrying a Book-by date', () => {
  const out = L.buildIcs(icsTrip([
    icsItem({ id: 'a1', title: 'Ferry to Hvar', location: 'Split', status: 'to-book', bookBy: '2027-06-01' }),
  ]), STAMP);
  const blocks = veventsOf(out);
  // Two events: the ferry itself, and the deadline to book it.
  assert.equal(blocks.length, 2);
  const deadline = blocks[1];
  // Its own UID, so a re-import cannot collide with the item's event.
  assert.equal(propOf(deadline, 'UID'), 'UID:a1-bookby@trip-planner.shevato.com');
  assert.equal(propOf(deadline, 'DTSTAMP'), 'DTSTAMP:20270102T030405Z');
  // An all-day event ON the deadline date, exclusive end the next day: the one
  // construct that says "this date, no clock time" in a way every client
  // renders. See the RFC note in trip-logic.js.
  assert.equal(propOf(deadline, 'DTSTART'), 'DTSTART;VALUE=DATE:20270601');
  assert.equal(propOf(deadline, 'DTEND'), 'DTEND;VALUE=DATE:20270602');
  assert.equal(propOf(deadline, 'SUMMARY'), 'SUMMARY:Book by: Ferry to Hvar');
  assert.equal(propOf(deadline, 'LOCATION'), 'LOCATION:Split');
  // ACTION:DISPLAY requires DESCRIPTION and TRIGGER (RFC 5545 3.6.6 dispprop).
  const alarm = deadline.slice(deadline.indexOf('BEGIN:VALARM'), deadline.indexOf('END:VALARM') + 1);
  assert.deepEqual(alarm, [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Book by: Ferry to Hvar',
    'TRIGGER;RELATED=START:PT0S',
    'END:VALARM',
  ]);
});

test('buildIcs never emits a date-valued TRIGGER, which RFC 5545 3.8.6.3 does not define', () => {
  // TRIGGER is a DURATION, or a DATE-TIME that MUST be UTC. There is no
  // TRIGGER;VALUE=DATE, and there is no bookBy clock time to build a UTC
  // DATE-TIME out of, which is the whole reason the deadline gets its own
  // all-day VEVENT instead of an alarm on the item's event.
  const out = L.buildIcs(icsTrip([
    icsItem({ id: 'a1', title: 'Ferry', status: 'to-book', bookBy: '2027-06-01' }),
    icsItem({ id: 'a2', title: 'Bus', status: 'to-book', startTime: '23:55', bookBy: '2027-06-02' }),
  ]), STAMP);
  assert.ok(!/TRIGGER;VALUE=DATE:/.test(out));
  assert.ok(!/TRIGGER;VALUE=DATE-TIME/.test(out));
  // and the item's own event gains nothing: a relative alarm there would fire
  // at 23:55, the item's clock, which is a time nobody entered for a deadline
  const blocks = veventsOf(out);
  assert.ok(!blocks[0].includes('BEGIN:VALARM'));
  assert.ok(!blocks[2].includes('BEGIN:VALARM'));
});

test('buildIcs writes no deadline entry once the item is booked, cancelled or parked', () => {
  // The exact rule the warnings panel applies: Booked is done, Decide later is
  // a deliberate maybe, Cancelled is off the trip. A stored date on any of them
  // is history, not a task.
  for (const status of ['booked', 'decide-later']) {
    const out = L.buildIcs(icsTrip([icsItem({ id: 'a1', status, bookBy: '2027-06-01' })]), STAMP);
    assert.equal(veventsOf(out).length, 1, status);
    assert.ok(!out.includes('BEGIN:VALARM'), status);
  }
  // cancelled items are dropped from the calendar entirely, deadline and all
  const cancelled = L.buildIcs(icsTrip([icsItem({ id: 'a1', status: 'cancelled', bookBy: '2027-06-01' })]), STAMP);
  assert.equal(veventsOf(cancelled).length, 0);
});

test('buildIcs deadline entries use the same predicate the warnings panel counts down', () => {
  // Proven rather than described: whatever bookingDeadlines is willing to
  // report is what the calendar is willing to write, so the two surfaces can
  // never drift apart.
  const items = [
    icsItem({ id: 'a1', status: 'to-book', bookBy: '2027-06-01' }),
    icsItem({ id: 'a2', status: 'booked', bookBy: '2027-06-01' }),
    icsItem({ id: 'a3', status: 'to-book' }),
    icsItem({ id: 'a4', status: 'to-book', bookBy: 'not-a-date' }),
    icsItem({ id: 'a5', status: 'to-book', bookBy: '2027-06-01', startDate: '' }),
  ];
  assert.deepEqual(items.filter(L.openBookingDeadline).map(it => it.id), ['a1']);
  const out = L.buildIcs(icsTrip(items), STAMP);
  assert.deepEqual(out.match(/UID:\S+-bookby@/g), ['UID:a1-bookby@']);
});

test('buildIcs leaves a trip with no Book-by dates byte-for-byte as it was', () => {
  const out = L.buildIcs(icsTrip([
    icsItem({ id: 'f1', type: 'flight', title: 'London (LHR) to Split (SPU)', startDate: '2027-06-01', startTime: '11:00', endDate: '2027-06-01', endTime: '14:05' }),
    icsItem({ id: 's1', type: 'stay', title: 'Hotel Park', location: 'Split', startDate: '2027-06-01', endDate: '2027-06-04' }),
    icsItem({ id: 'a1', title: 'Ferry to Hvar', location: 'Split', status: 'to-book', startDate: '2027-06-04' }),
  ]), STAMP);
  assert.equal(out, [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Shevato//Trip Planner//EN', 'X-WR-CALNAME:Croatia',
    'BEGIN:VEVENT', 'UID:f1@trip-planner.shevato.com', 'DTSTAMP:20270102T030405Z',
    'DTSTART:20270601T110000', 'DTEND:20270601T140500',
    'SUMMARY:London (LHR) to Split (SPU)', 'DESCRIPTION:Status: Booked', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:s1@trip-planner.shevato.com', 'DTSTAMP:20270102T030405Z',
    'DTSTART;VALUE=DATE:20270601', 'DTEND;VALUE=DATE:20270604',
    'SUMMARY:Hotel Park', 'LOCATION:Split', 'DESCRIPTION:Status: Booked', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a1@trip-planner.shevato.com', 'DTSTAMP:20270102T030405Z',
    'DTSTART;VALUE=DATE:20270604', 'DTEND;VALUE=DATE:20270605',
    'SUMMARY:Ferry to Hvar', 'LOCATION:Split', 'DESCRIPTION:Status: To book', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n');
});

test('buildIcs keeps a date-line flight as a point event rather than ending before it starts', () => {
  // validateItem deliberately ACCEPTS a flight that lands the same day at an
  // earlier local clock (eastbound across the date line, or any westbound hop
  // that gains hours). RFC 5545 3.8.2.2 requires DTEND to be later than
  // DTSTART, so composing one from those two fields wrote an event strict
  // clients drop. The app holds no timezone data, so the honest rendering is
  // the same zero-length point event an item with no end time already gets.
  const out = L.buildIcs(icsTrip([
    icsItem({ id: 'f1', type: 'flight', title: 'Tokyo (NRT) to Honolulu (HNL)', startDate: '2027-06-01', startTime: '19:30', endDate: '2027-06-01', endTime: '07:45' }),
  ]), STAMP);
  const ev = veventsOf(out)[0];
  assert.equal(propOf(ev, 'DTSTART'), 'DTSTART:20270601T193000');
  assert.equal(propOf(ev, 'DTEND'), 'DTEND:20270601T193000');
});

test('buildIcs treats an end that merely equals the start the same way', () => {
  const out = L.buildIcs(icsTrip([
    icsItem({ id: 'f1', type: 'transport', title: 'Airport shuttle', startDate: '2027-06-01', startTime: '08:00', endDate: '2027-06-01', endTime: '08:00' }),
  ]), STAMP);
  const ev = veventsOf(out)[0];
  assert.equal(propOf(ev, 'DTEND'), 'DTEND:20270601T080000');
});

test('buildIcs still honours a genuine overnight leg, where the end really is later', () => {
  const out = L.buildIcs(icsTrip([
    icsItem({ id: 'f1', type: 'flight', title: 'Split (SPU) to Tokyo (HND)', startDate: '2027-06-01', startTime: '22:10', endDate: '2027-06-02', endTime: '06:35' }),
  ]), STAMP);
  const ev = veventsOf(out)[0];
  assert.equal(propOf(ev, 'DTSTART'), 'DTSTART:20270601T221000');
  assert.equal(propOf(ev, 'DTEND'), 'DTEND:20270602T063500');
});

test('every VEVENT buildIcs writes obeys the DTEND-not-before-DTSTART rule', () => {
  const out = L.buildIcs(icsTrip([
    icsItem({ id: 'f1', type: 'flight', title: 'Date line', startDate: '2027-06-01', startTime: '19:30', endDate: '2027-06-01', endTime: '07:45' }),
    icsItem({ id: 's1', type: 'stay', title: 'Hotel Park', location: 'Split', startDate: '2027-06-02', endDate: '2027-06-05', status: 'to-book', bookBy: '2027-05-01' }),
    icsItem({ id: 'a1', title: 'Ferry', status: 'to-book', startDate: '2027-06-06', startTime: '09:00', bookBy: '2027-05-20' }),
    icsItem({ id: 'n1', type: 'note', title: 'Passport check', startDate: '2027-06-07' }),
  ]), STAMP);
  const blocks = veventsOf(out);
  assert.equal(blocks.length, 6); // 4 items + 2 deadlines
  for (const b of blocks) {
    const st = propOf(b, 'DTSTART').split(':')[1];
    const en = propOf(b, 'DTEND').split(':')[1];
    assert.ok(en >= st, `DTEND ${en} must not precede DTSTART ${st}`);
  }
});

test('buildIcs prints the meal wording in a deadline the same way it prints it in the event', () => {
  const out = L.buildIcs(icsTrip([
    icsItem({ id: 'a1', title: 'Narisawa', meal: 'dinner', status: 'to-book', startDate: '2027-06-08', startTime: '19:00', bookBy: '2027-05-08' }),
  ]), STAMP);
  assert.ok(out.includes('SUMMARY:Dinner: Narisawa\r\n'));
  assert.ok(out.includes('SUMMARY:Book by: Dinner: Narisawa\r\n'));
});
