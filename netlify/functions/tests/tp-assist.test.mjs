import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { GENERATION_CONFIG, readCandidate } from '../tp-assist.mjs';

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
  assert.ok(GENERATION_CONFIG.maxOutputTokens >= 4000,
    'a measured turn spends ~800 tokens thinking before writing a word');
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
