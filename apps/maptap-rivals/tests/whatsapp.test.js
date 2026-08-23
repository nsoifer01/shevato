'use strict';

// Unit tests for js/whatsapp.js: every export header shape the importer
// claims to read, day/month-order inference, and the calendar-day rules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../js/whatsapp.js');
const S = require('../js/stats.js');

const shareParts = (body) => { const p = S.parseMapTapScore(body); return p && p.dateParts; };

test('parseHeaderLine: Android 24-hour "M/D/YY, HH:MM - Name:"', () => {
  const h = W.parseHeaderLine('8/10/26, 21:05 - Nikita: MapTap');
  assert.equal(h.style, 'android');
  assert.deepEqual([h.a, h.b, h.c, h.hour, h.minute, h.second, h.hour12, h.sender, h.body], ['8', '10', '26', 21, 5, null, false, 'Nikita', 'MapTap']);
});

test('parseHeaderLine: Android 12-hour "9:05 PM" (US default) and "a.m."', () => {
  assert.equal(W.parseHeaderLine('8/10/26, 9:05 PM - Ari: x').hour, 21);
  assert.equal(W.parseHeaderLine('8/10/26, 12:05 AM - Ari: x').hour, 0);
  assert.equal(W.parseHeaderLine('8/10/26, 12:05 PM - Ari: x').hour, 12);
  assert.equal(W.parseHeaderLine('8/10/26, 9:05 a.m. - Ari: x').hour, 9);
  assert.equal(W.parseHeaderLine('8/10/26, 9:05 p. m. - Ari: x').hour, 21);
});

test('parseHeaderLine: iPhone bracketed "[M/D/YY, HH:MM:SS] Name:" with seconds, 4-digit years and narrow spaces', () => {
  const h = W.parseHeaderLine('[8/10/2026, 9:05:12 PM] Ari: MapTap Aug 10');
  assert.equal(h.style, 'ios');
  assert.deepEqual([h.a, h.b, h.c, h.hour, h.second, h.hour12, h.sender], ['8', '10', '2026', 21, 12, true, 'Ari']);
  assert.equal(W.parseHeaderLine('‎[10/08/26, 21:05:00] Ari: x').hour, 21);
});

test('parseHeaderLine: dot and dash separators and year-first dates', () => {
  assert.deepEqual(W.parseHeaderLine('10.08.26, 21:05 - Bex: x').a, '10');
  assert.deepEqual(W.parseHeaderLine('10-08-26, 21:05 - Bex: x').b, '08');
  assert.equal(W.parseHeaderLine('2026-08-10, 21:05 - Bex: x').a, '2026');
});

test('parseHeaderLine: rejects non-headers and impossible times', () => {
  assert.equal(W.parseHeaderLine('just text: with a colon'), null);
  assert.equal(W.parseHeaderLine('8/10/26, 25:05 - Ari: x'), null);
  assert.equal(W.parseHeaderLine('Aug 10\n95 89 91 9 64'), null);
  assert.equal(W.parseHeaderLine(''), null);
});

test('parseWhatsAppText: continuation lines join the previous body; leading junk is counted', () => {
  const r = W.parseWhatsAppText('export header junk\n8/10/26, 21:05 - Nikita: MapTap\nAug 10\n95 89 91 9 64\nFinal score: 585\n8/10/26, 21:07 - Ari: hi');
  assert.equal(r.messages.length, 2);
  assert.equal(r.skippedLeadingLines, 1);
  assert.equal(r.messages[0].body.split('\n').length, 4);
  assert.equal(r.messages[1].body, 'hi');
});

test('parseWhatsAppText: a mixed Android + iOS file still reads every message', () => {
  const r = W.parseWhatsAppText('8/10/26, 21:05 - A: x\n[8/10/26, 21:06:00] B: y\n8/10/26, 9:07 PM - C: z');
  assert.deepEqual(r.messages.map(m => m.sender), ['A', 'B', 'C']);
});

test('detectDateOrder: a first field above 12 means day-first', () => {
  const { messages } = W.parseWhatsAppText('31/12/25, 23:50 - A: x\n1/1/26, 00:30 - B: y');
  assert.deepEqual(W.detectDateOrder(messages), { order: 'DMY', certain: true, evidence: { yearFirst: 0, dayFirst: 1, monthFirst: 0, bodyDayFirst: 0, bodyMonthFirst: 0, conflicts: 0 } });
});

test('detectDateOrder: a second field above 12 means month-first', () => {
  const { messages } = W.parseWhatsAppText('12/31/25, 23:50 - A: x');
  assert.equal(W.detectDateOrder(messages).order, 'MDY');
  assert.equal(W.detectDateOrder(messages).certain, true);
});

test('detectDateOrder: a 4-digit first field is year-first', () => {
  const { messages } = W.parseWhatsAppText('2026-08-10, 21:05 - A: x');
  assert.equal(W.detectDateOrder(messages).order, 'YMD');
});

test('detectDateOrder: the MapTap share date inside a body settles an otherwise ambiguous file', () => {
  const dmy = W.parseWhatsAppText('10/8/26, 21:05 - A: MapTap\nAug 10\n95 89 91 9 64').messages;
  assert.deepEqual([W.detectDateOrder(dmy, shareParts).order, W.detectDateOrder(dmy, shareParts).certain], ['DMY', true]);
  const mdy = W.parseWhatsAppText('8/10/26, 21:05 - A: MapTap\nAug 10\n95 89 91 9 64').messages;
  assert.deepEqual([W.detectDateOrder(mdy, shareParts).order, W.detectDateOrder(mdy, shareParts).certain], ['MDY', true]);
});

test('detectDateOrder: no evidence at all is reported as uncertain, never silently decided', () => {
  const { messages } = W.parseWhatsAppText('8/10/26, 21:05 - A: hello\n9/11/26, 21:05 - A: hello');
  const d = W.detectDateOrder(messages, shareParts);
  assert.equal(d.certain, false);
  assert.equal(d.order, 'MDY');
});

test('detectDateOrder: contradictory evidence goes with the majority but stays uncertain', () => {
  const { messages } = W.parseWhatsAppText('13/1/26, 21:05 - A: x\n14/1/26, 21:05 - A: x\n1/13/26, 21:05 - A: x');
  const d = W.detectDateOrder(messages);
  assert.equal(d.order, 'DMY');
  assert.equal(d.certain, false);
});

test('applyDateOrder: resolves year/month/day per order and flags impossible dates', () => {
  const { messages } = W.parseWhatsAppText('31/4/26, 21:05 - A: x\n10/8/26, 21:05 - A: y\n2/29/24, 21:05 - A: z');
  const dmy = W.applyDateOrder(messages, 'DMY');
  assert.equal(dmy[0].invalidDate, true);
  assert.equal(dmy[1].dateISO, '2026-08-10');
  const mdy = W.applyDateOrder(messages, 'MDY');
  assert.equal(mdy[1].dateISO, '2026-10-08');
  assert.equal(mdy[2].dateISO, '2024-02-29');
  assert.equal(W.applyDateOrder(W.parseWhatsAppText('2026-08-10, 1:00 - A: x').messages, 'YMD')[0].dateISO, '2026-08-10');
});

test('applyDateOrder: two-digit years pivot at 70', () => {
  const { messages } = W.parseWhatsAppText('8/10/69, 21:05 - A: x\n8/10/70, 21:05 - A: x');
  const out = W.applyDateOrder(messages, 'MDY');
  assert.equal(out[0].year, 2069);
  assert.equal(out[1].year, 1970);
});

test('isoFromYMD: only real calendar days', () => {
  assert.equal(W.isoFromYMD(2024, 1, 29), '2024-02-29');
  assert.equal(W.isoFromYMD(2026, 1, 29), null);
  assert.equal(W.isoFromYMD(2026, 3, 31), null);
  assert.equal(W.isoFromYMD(2026, 0, 1), '2026-01-01');
  assert.equal(W.isoFromYMD(NaN, 0, 1), null);
});

function msg(header, body) {
  return W.applyDateOrder(W.parseWhatsAppText(`${header} - A: ${body}`).messages, 'MDY')[0];
}

test('dayBucketDate: the body date wins over the header date (1am share is yesterday\'s puzzle)', () => {
  const m = msg('8/12/26, 01:00', 'MapTap\nAug 11\n60 60 60 60 60\nFinal score: 600');
  assert.equal(W.dayBucketDate(m, S.parseMapTapScore(m.body)), '2026-08-11');
});

test('dayBucketDate: December share sent in January belongs to the previous year', () => {
  const m = msg('1/1/26, 00:30', 'MapTap\nDecember 31\n80 80 80 80 80\nFinal score: 800');
  assert.equal(W.dayBucketDate(m, S.parseMapTapScore(m.body)), '2025-12-31');
});

test('dayBucketDate: January share sent on New Year\'s Eve belongs to the next year', () => {
  const m = msg('12/31/25, 23:55', 'MapTap\nJanuary 1\n30 30 30 30 30\nFinal score: 300');
  assert.equal(W.dayBucketDate(m, S.parseMapTapScore(m.body)), '2026-01-01');
});

test('dayBucketDate: Feb 29 in a leap year is kept, in a common year it is null (never Mar 1)', () => {
  const leap = msg('2/29/24, 21:00', 'MapTap\nFebruary 29\n30 30 30 30 30\nFinal score: 300');
  assert.equal(W.dayBucketDate(leap, S.parseMapTapScore(leap.body)), '2024-02-29');
  const common = msg('3/1/26, 00:10', 'MapTap\nFebruary 29\n30 30 30 30 30\nFinal score: 300');
  assert.equal(W.dayBucketDate(common, S.parseMapTapScore(common.body)), null);
});

test('dayBucketDate: a share without a body date falls back to the header day', () => {
  const m = msg('8/10/26, 21:05', 'MapTap\n95 89 91 9 64\nFinal score: 585');
  assert.equal(W.dayBucketDate(m, S.parseMapTapScore(m.body)), '2026-08-10');
});

test('dayBucketDate: an invalid header date with no body date yields null', () => {
  const m = W.applyDateOrder(W.parseWhatsAppText('31/4/26, 21:05 - A: MapTap\n95 89 91 9 64').messages, 'DMY')[0];
  assert.equal(W.dayBucketDate(m, S.parseMapTapScore(m.body)), null);
});

test('parseMapTapShareStrict: five numbers without a MapTap marker are not a share', () => {
  assert.equal(W.parseMapTapShareStrict('lol 1 2 3 4 5', S.parseMapTapScore), null);
  assert.ok(W.parseMapTapShareStrict('MapTap\n1 2 3 4 5', S.parseMapTapScore));
  assert.ok(W.parseMapTapShareStrict('Final score: 15\n1 2 3 4 5', S.parseMapTapScore));
  assert.equal(W.parseMapTapShareStrict('', S.parseMapTapScore), null);
});
