import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../tp-assist.mjs';

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
