import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { clampBody, ATTRIBUTION } from '../tp-places.mjs';

// These exercise only the paths that return BEFORE any Blob I/O: the
// origin/referer guard, the method guard, and the body clamp. The quota, cache
// and matching logic are covered by tp-places-quota / -lookup / -match; the
// store and upstream calls need a live Netlify Blobs context.

function req({ origin, referer, method = 'POST', body } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (referer) headers.Referer = referer;
  const init = { method, headers };
  if (body !== undefined && method !== 'GET') init.body = body;
  return new Request('https://shevato.com/.netlify/functions/tp-places', init);
}
const goodBody = () => JSON.stringify({ clientId: 'client-1', queries: ['Ichiran Shibuya'] });

test('rejects a request with no origin or referer', async () => {
  const res = await handler(req({ body: goodBody() }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin_rejected');
});

test('rejects a foreign origin', async () => {
  // Without this, anyone could point a script at the endpoint and spend the
  // owner's Places budget.
  const res = await handler(req({ origin: 'https://evil.example.com', body: goodBody() }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'origin_rejected');
});

test('rejects plain http on the production hostname', async () => {
  const res = await handler(req({ origin: 'http://shevato.com', body: goodBody() }));
  assert.equal(res.status, 403);
});

test('accepts the production origin (passes the guard)', async () => {
  // A valid origin with a bad body must reach the 400 clamp, proving the guard
  // let it through rather than 403.
  const res = await handler(req({ origin: 'https://shevato.com', body: 'not json' }));
  assert.equal(res.status, 400);
});

test('accepts localhost origins for local dev', async () => {
  const res = await handler(req({ origin: 'http://localhost:8081', body: 'not json' }));
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

test('rejects a body with no queries', async () => {
  const body = JSON.stringify({ clientId: 'c1', queries: [] });
  const res = await handler(req({ origin: 'https://shevato.com', body }));
  assert.equal(res.status, 400);
});

test('rejects a body with no clientId', async () => {
  // The clientId is what the per-client quota is keyed on; without it one
  // browser could spend the whole global budget.
  const body = JSON.stringify({ queries: ['Ichiran Shibuya'] });
  const res = await handler(req({ origin: 'https://shevato.com', body }));
  assert.equal(res.status, 400);
});

test('no guard response ever carries a key or upstream detail', async () => {
  // Belt and braces on the contract that the browser learns nothing about the
  // Places key or Google's error bodies.
  const responses = await Promise.all([
    handler(req({ body: goodBody() })),
    handler(req({ origin: 'https://evil.example.com', body: goodBody() })),
    handler(req({ origin: 'https://shevato.com', method: 'GET' })),
    handler(req({ origin: 'https://shevato.com', body: 'not json' })),
  ]);
  for (const res of responses) {
    const text = await res.text();
    assert.match(text, /^\{"error":"[a-z_]+"\}$/, 'guard responses are a bare error code');
    assert.doesNotMatch(text, /key|AIza|googleapis/i);
  }
});

// ---------- body clamp ----------

test('the batch is capped so one request cannot run up a large bill', () => {
  // Twelve billed lookups is $0.24; an uncapped batch is whatever the caller
  // felt like sending.
  const queries = Array.from({ length: 40 }, (_, i) => 'Venue number ' + i);
  const out = clampBody({ clientId: 'c1', queries });
  assert.equal(out.ok, true);
  assert.equal(out.queries.length, 12);
});

test('duplicate queries collapse to one lookup', () => {
  // A day plan proposes the same hotel bar for two slots; paying twice for it
  // inside a single request would be pure waste.
  const out = clampBody({ clientId: 'c1', queries: ['Ichiran Shibuya', 'Ichiran Shibuya', 'Nabezo Shinjuku'] });
  assert.deepEqual(out.queries, ['Ichiran Shibuya', 'Nabezo Shinjuku']);
});

test('query strings are clamped to the length trip-logic already enforces', () => {
  const out = clampBody({ clientId: 'c1', queries: ['x'.repeat(500)] });
  assert.equal(out.queries[0].length, 200);
});

test('the clientId is clamped and non-string entries are dropped', () => {
  const out = clampBody({ clientId: 'c'.repeat(300), queries: [null, 42, {}, '  Ichiran Shibuya  '] });
  assert.equal(out.clientId.length, 100);
  assert.deepEqual(out.queries, ['Ichiran Shibuya']);
});

test('a body whose queries are all junk is rejected rather than half-served', () => {
  assert.equal(clampBody({ clientId: 'c1', queries: [null, '', '   '] }).ok, false);
  assert.equal(clampBody({ clientId: 'c1', queries: 'Ichiran' }).ok, false);
  assert.equal(clampBody(null).ok, false);
});

// ---------- attribution ----------

test('every successful response carries the Google Maps attribution', () => {
  // Google Maps Platform attribution requirements: content must be visibly
  // identified as Google Maps content. The client renders this next to the
  // rating; shipping it in the response keeps one definition of the obligation.
  assert.equal(ATTRIBUTION.text, 'Google Maps');
  assert.match(ATTRIBUTION.url, /^https:\/\/www\.google\.com\/maps/);
});
