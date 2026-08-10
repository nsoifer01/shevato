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
