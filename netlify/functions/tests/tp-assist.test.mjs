import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { GENERATION_CONFIG, readCandidate, buildSystemInstruction } from '../tp-assist.mjs';
import TripLogic from '../../../apps/trip-planner/js/trip-logic.js';

// These exercise only the guard paths that return BEFORE any Blob I/O: the
// origin/referer guard, the method guard, and the body clamp. The quota logic
// is covered by tp-assist-quota.test.mjs; the store/upstream path needs a live
// Netlify Blobs context and is verified by code review + the quota unit tests.

function req({ origin, referer, method = 'POST', body } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (referer) headers.Referer = referer;
  const init = { method, headers };
  if (body !== undefined && method !== 'GET') init.body = body;
  return new Request('https://shevato.com/.netlify/functions/tp-assist', init);
}
const goodBody = () => JSON.stringify({
  clientId: 'client-1',
  messages: [{ role: 'user', content: 'hello' }],
  tripContext: { trip: { name: 'x', items: [] }, today: '2026-07-19' },
});

test('rejects a request with no origin or referer', async () => {
  const res = await handler(req({ body: goodBody() }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin_rejected');
});

test('rejects a foreign origin', async () => {
  const res = await handler(req({ origin: 'https://evil.example.com', body: goodBody() }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin_rejected');
});

test('accepts the production origin (passes the guard)', async () => {
  // A valid origin but a bad body must reach the 400 clamp, proving the guard
  // let it through rather than 403.
  const res = await handler(req({ origin: 'https://shevato.com', body: 'not json' }));
  assert.equal(res.status, 400);
});

test('accepts localhost origins for local dev', async () => {
  const res = await handler(req({ origin: 'http://localhost:8082', body: 'not json' }));
  assert.equal(res.status, 400);
});

test('falls back to the referer when origin is absent', async () => {
  const res = await handler(req({ referer: 'https://shevato.com/apps/trip-planner/', body: 'not json' }));
  assert.equal(res.status, 400);
});

test('rejects non-POST methods', async () => {
  const res = await handler(req({ origin: 'https://shevato.com', method: 'GET' }));
  assert.equal(res.status, 405);
});

test('rejects a body with no messages', async () => {
  const body = JSON.stringify({ clientId: 'c1', messages: [], tripContext: {} });
  const res = await handler(req({ origin: 'https://shevato.com', body }));
  assert.equal(res.status, 400);
});

test('rejects a body with no clientId', async () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  const res = await handler(req({ origin: 'https://shevato.com', body }));
  assert.equal(res.status, 400);
});

test('rejects an oversized tripContext', async () => {
  const big = 'x'.repeat(31000);
  const body = JSON.stringify({ clientId: 'c1', messages: [{ role: 'user', content: 'hi' }], tripContext: { blob: big } });
  const res = await handler(req({ origin: 'https://shevato.com', body }));
  assert.equal(res.status, 400);
});

// ---------- generation config + reply reading ----------
// Regression cover for the 2026-07-19 truncation bug: Gemini 3.x bills its
// internal reasoning to maxOutputTokens, so the old 1000 cap returned a
// half-sentence with the tripActions JSON cut off.

test('the generation budget leaves room for reasoning plus a full answer', () => {
  // A full "plan my day" turn is ~19 add actions (agenda entries plus 2-3
  // alternatives per meal and drinks slot) on top of ~800-1500 thinking
  // tokens. 4000 was sized for a two-suggestion turn and truncates here, and
  // truncation drops the tripActions block at the tail.
  assert.ok(GENERATION_CONFIG.maxOutputTokens >= 8000,
    'a full day plan with alternative sets does not fit in the old 4000 budget');
  assert.equal(GENERATION_CONFIG.thinkingConfig.thinkingLevel, 'low');
});

test('readCandidate joins text parts and ignores thought-signature parts', () => {
  const data = { candidates: [{ finishReason: 'STOP', content: { parts: [
    { text: 'Dinner first. ' },
    { thoughtSignature: 'abc' },
    { text: 'Then drinks.' },
  ] } }] };
  const out = readCandidate(data);
  assert.equal(out.text, 'Dinner first. Then drinks.');
  assert.equal(out.truncated, false);
});

test('readCandidate flags a MAX_TOKENS reply and tells the traveller', () => {
  const data = { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'For dinner, I' }] } }] };
  const out = readCandidate(data);
  assert.equal(out.truncated, true);
  assert.match(out.text, /^For dinner, I/);
  assert.match(out.text, /cut short/);
});

test('readCandidate survives an empty or malformed candidate', () => {
  assert.deepEqual(readCandidate({}), { text: '', truncated: false });
  assert.deepEqual(readCandidate({ candidates: [] }), { text: '', truncated: false });
  assert.deepEqual(readCandidate({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), { text: '', truncated: true });
});

// ---------- system instruction: one source of truth ----------
// This function used to hand-copy the contract into a local SYSTEM_PREAMBLE, so
// every client-side contract change silently left Tier 3 on the old shape.
// These tests fail the moment the two drift apart again.

const ctx = () => ({
  trip: { name: 'Tokyo', currency: 'JPY', items: [{ id: 'a', type: 'stay', title: 'Park Hotel', location: 'Tokyo', startDate: '2026-12-29', endDate: '2027-01-03' }] },
  today: '2026-07-19',
  focusDate: '2026-12-31',
});

test('buildSystemInstruction is byte-identical to the client contract builder', () => {
  const c = ctx();
  assert.equal(buildSystemInstruction(c), TripLogic.buildAssistSystemPrompt({
    trip: c.trip, focusDate: c.focusDate, today: c.today, mode: 'chat', origin: null,
  }));
});

// The guided picker's fixed option counts are the ONE thing this endpoint must
// not hand out by default: a body with no mode (an old client, a hand-rolled
// request, a dropped field) is a free-form turn, so the traveller is never told
// that "instructions require exactly 3" when they never opened the picker.
test('buildSystemInstruction defaults an absent or unknown mode to free-form chat', () => {
  for (const mode of [undefined, '', 'plans', 'PLAN', 42, null, {}]) {
    const sys = buildSystemInstruction({ ...ctx(), mode });
    assert.match(sys, /How MANY options to offer is the traveller's call/, `mode ${JSON.stringify(mode)}`);
    assert.doesNotMatch(sys, /propose EXACTLY 3 candidates/, `mode ${JSON.stringify(mode)}`);
  }
});

test('buildSystemInstruction carries the guided counts only when mode is plan', () => {
  const sys = buildSystemInstruction({ ...ctx(), mode: 'plan' });
  assert.match(sys, /propose EXACTLY 3 candidates/);
  assert.match(sys, /propose EXACTLY 2 candidates for that one slot/);
  assert.doesNotMatch(sys, /How MANY options to offer is the traveller's call/);
});

test('buildSystemInstruction clamps the origin and drops a nameless one', () => {
  const long = { label: 'H'.repeat(400), city: 'C'.repeat(400), date: '2026-12-31T09:00:00Z', source: 'stay' };
  const sys = buildSystemInstruction({ ...ctx(), origin: long });
  assert.match(sys, /The traveller is based on 2026-12-31 at H{120} in C{80} -/);
  assert.doesNotMatch(sys, /H{121}/);
  for (const bad of [null, undefined, 'a string', { label: '   ' }, { city: 'Tokyo' }, 7]) {
    assert.doesNotMatch(buildSystemInstruction({ ...ctx(), origin: bad }), /The traveller is based/,
      `origin ${JSON.stringify(bad)}`);
  }
});

// The app draws the figure; the model used to talk the traveller out of reading
// it ("I do not have access to live GPS or real-time traffic data").
test('buildSystemInstruction tells the model the app measures distance itself', () => {
  const sys = buildSystemInstruction(ctx());
  assert.match(sys, /This app measures distance itself/);
  assert.match(sys, /never explain that you lack GPS, live traffic, maps or location access/);
  assert.match(sys, /Do not state a distance, a walking time, a driving time, a\s+fare or a journey time as a fact/);
});

test('buildSystemInstruction carries the agenda and grouping rules from trip-logic', () => {
  const sys = buildSystemInstruction(ctx());
  assert.match(sys, /ONE add action per agenda entry/);
  assert.match(sys, /New Year's Eve in Tokyo/);
  // Tier 3 must inherit the exactly-what-was-asked rule too: the production
  // report (breakfast only, full day returned) came back through this path.
  assert.match(sys, /Plan exactly the slots the traveller asked for/);
  assert.match(sys, /Never introduce a slot type the traveller did not request/);
  assert.doesNotMatch(sys, /breakfast AND lunch AND dinner/);
  assert.match(sys, /Return to hotel/);
  // the grouping MECHANIC is contract in both modes; the counts are not
  assert.match(sys, /the same "group" value on its action/);
  assert.match(sys, /Transport, local hops, stays and notes are NEVER grouped/);
  assert.match(sys, /limited to flight, transport, local, activity, stay and note/);
  // tier 3 must inherit the between-cities vs within-a-city split too
  assert.match(sys, /"local" for getting around WITHIN one city/);
});

test('buildSystemInstruction includes the trip, today and focus day', () => {
  const sys = buildSystemInstruction(ctx());
  assert.match(sys, /Park Hotel/);
  assert.match(sys, /Today is 2026-07-19/);
  assert.match(sys, /focused on this day: 2026-12-31/);
});

test('buildSystemInstruction tolerates a payload with no trip, today or focus', () => {
  const sys = buildSystemInstruction({});
  assert.match(sys, /"tripActions"/);
  assert.doesNotMatch(sys, /Today is/);
  assert.doesNotMatch(sys, /focused on this day/);
});

// ---------- oversize trip: trimmed, not rejected ----------
// A trip of ~45 items with 500-char descriptions crosses MAX_TRIP_JSON. It used
// to come back as a bare 400 with no explanation, which is indistinguishable
// from "you sent garbage" for a traveller whose only mistake was writing notes.

function heavyContext(n, detailChars) {
  return {
    trip: { name: 'Heavy', currency: 'USD', items: Array.from({ length: n }, (_, i) => ({
      id: 'i' + i, type: 'activity', title: 'Item ' + i, location: 'Tokyo',
      startDate: '2027-05-01', startTime: '10:00', status: 'to-book',
      cost: 40, costCurrency: 'USD', details: 'd'.repeat(detailChars),
    })) },
    focusDate: null,
    today: '2027-04-01',
  };
}
const bodyWith = ctx => JSON.stringify({
  clientId: 'client-1',
  messages: [{ role: 'user', content: 'plan my day' }],
  tripContext: ctx,
});

test('an oversize trip is no longer a bad request', async () => {
  const ctx = heavyContext(50, 500);
  assert.ok(JSON.stringify(ctx).length > 30000, 'fixture must actually be oversize');
  // It gets PAST the clamp, so execution reaches the lazy Blob store import,
  // which throws in a bare test environment. That throw is the proof: the old
  // code returned a 400 here and never got this far. The exact message depends
  // on the environment: where @netlify/blobs is installed (local, in the
  // gitignored functions node_modules) getStore throws "...Netlify Blobs..."
  // not-configured; on CI the package is absent so the import itself fails with
  // "Cannot find package '@netlify/blobs'". Either one means we reached the
  // store, so match both rather than pinning one machine's shape.
  await assert.rejects(
    () => handler(req({ origin: 'https://shevato.com', body: bodyWith(ctx) })),
    /Netlify Blobs|@netlify\/blobs/i,
  );
});

test('a trip too big even without descriptions answers 413, not a bare 400', async () => {
  // structural facts alone over the cap: retrying can never succeed, so the
  // user has to be told what happened rather than shown a generic failure
  const res = await handler(req({ origin: 'https://shevato.com', body: bodyWith(heavyContext(4000, 500)) }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'trip_too_large');
});

test('a genuinely malformed body still answers 400, so the two stay distinguishable', async () => {
  const res = await handler(req({ origin: 'https://shevato.com', body: JSON.stringify({ clientId: '', messages: [] }) }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_request');
});

test('the system instruction warns the model when the trip was trimmed', () => {
  const trimmed = TripLogic.fitAssistContext(heavyContext(50, 500), 30000);
  assert.equal(trimmed.truncated, true);
  const sys = buildSystemInstruction(trimmed.ctx, trimmed.truncated);
  assert.ok(sys.includes(TripLogic.ASSIST_TRUNCATED_NOTE));
  // an intact trip must NOT carry the warning, or it becomes noise the model
  // learns to ignore on the requests where it matters
  const intact = TripLogic.fitAssistContext(heavyContext(3, 50), 30000);
  assert.equal(intact.truncated, false);
  assert.equal(buildSystemInstruction(intact.ctx, intact.truncated).includes(TripLogic.ASSIST_TRUNCATED_NOTE), false);
});
