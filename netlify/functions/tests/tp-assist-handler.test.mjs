// tp-assist handler steps 4-9: config blob, quota reservation, the Gemini
// call, and the reply guards. tp-assist.test.mjs stops at step 3 (the guards
// that return before any Blob I/O); this file drives the rest of the handler.
//
// AUDIT CLAIM, VERIFIED FALSE: "steps 4-9 are unreachable because the blob
// store import is not injectable." The store import is LAZY
// (`await import('./lib/tp-assist-store.mjs')` inside the handler, after the
// cheap guards), so a node:module register() customization hook installed by
// this very file redirects the store's own `@netlify/blobs` import to an
// in-memory CAS stub (tp-assist-blobs-stub.mjs) before the first request runs.
// No production change is needed. Without the hook the claim does hold:
// @netlify/blobs exists only in the Netlify build, so the lazy import throws
// locally and every path past step 3 is dead to a plain test.
//
// The upstream call is stubbed by replacing global fetch: callGemini is the
// only fetch in the handler.
import { register } from 'node:module';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { ASSIST_UPSTREAM_TIMEOUT_MS } from '../tp-assist.mjs';
import { DEFAULT_LIMITS } from '../lib/tp-assist-quota.mjs';

let hooksOk = true;
try {
  register('./tp-assist-blobs-hooks.mjs', import.meta.url);
} catch {
  hooksOk = false; // Node < 20.6: no customization hooks, nothing past step 3
}
const opts = hooksOk ? {} : { skip: 'node:module register() unavailable; steps 4-9 need the @netlify/blobs hook' };

const STORE = 'trip-planner-assist';

function seedBlobs({ config, usage } = {}) {
  const map = new Map();
  if (config !== undefined) map.set('config', { data: config, etag: 'etag-config-seed' });
  if (usage !== undefined) map.set('usage', { data: usage, etag: 'etag-usage-seed' });
  globalThis.__tpAssistBlobStub = { stores: { [STORE]: map }, seq: 0 };
  return map;
}
const storedUsage = () => {
  const e = globalThis.__tpAssistBlobStub.stores[STORE].get('usage');
  return e ? e.data : null;
};

function req(body) {
  return new Request('https://shevato.com/.netlify/functions/tp-assist', {
    method: 'POST',
    headers: { Origin: 'https://shevato.com' },
    body: JSON.stringify(body),
  });
}
const goodBody = (clientId = 'client-1') => ({
  clientId,
  messages: [{ role: 'user', content: 'suggest dinner' }],
  tripContext: { trip: { name: 'x', items: [] }, today: '2026-08-15' },
});

// Current-time quota buckets, mirroring tp-assist-quota's own bucket math, so
// a preseeded counter is read as live rather than pruned as stale.
const hb = () => Math.floor(Date.now() / 3600000);
const db = () => Math.floor(Date.now() / 86400000);
const liveUsage = (over = {}) => ({
  hourBucket: hb(), dayBucket: db(), clientHour: {}, clientDay: {}, globalDay: 0, ...over,
});

const geminiJson = (parts, finishReason = 'STOP') => JSON.stringify({
  candidates: [{ content: { parts }, finishReason }],
});

const realFetch = globalThis.fetch;
let fetchCalls;
function stubGemini(status, body) {
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body || {}), { status });
  };
}

beforeEach(() => { delete process.env.TP_GEMINI_KEY; fetchCalls = []; });
afterEach(() => { globalThis.fetch = realFetch; delete globalThis.__tpAssistBlobStub; });

test('step 4: an empty config blob answers 503 not_configured', opts, async () => {
  seedBlobs({ config: {} });
  stubGemini(200, geminiJson([{ text: 'never reached' }]));
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_configured');
  assert.equal(fetchCalls.length, 0, 'no upstream call without a key');
});

test('step 4: a missing config blob (never written) also answers 503', opts, async () => {
  seedBlobs({});
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 503);
});

test('steps 5-9: a configured key reaches Gemini and returns the reply', opts, async () => {
  seedBlobs({ config: { geminiKey: 'test-key-123' } });
  stubGemini(200, geminiJson([{ text: 'Here are two ideas.' }]));
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reply, 'Here are two ideas.');
  // the key travels in the header, never in the URL
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /generativelanguage\.googleapis\.com\/.*generateContent$/);
  assert.ok(!fetchCalls[0].url.includes('test-key-123'));
  assert.equal(fetchCalls[0].init.headers['x-goog-api-key'], 'test-key-123');
  // step 5 reserved the quota: the usage blob now carries the counters
  const u = storedUsage();
  assert.equal(u.globalDay, 1);
  assert.equal(u.clientDay['client-1'], 1);
  assert.equal(u.clientHour['client-1'], 1);
});

test('step 5: a spent global pool answers 429 and never calls upstream', opts, async () => {
  seedBlobs({
    config: { geminiKey: 'k' },
    usage: liveUsage({ globalDay: DEFAULT_LIMITS.globalDay }),
  });
  stubGemini(200, geminiJson([{ text: 'never' }]));
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(body.scope, 'global_day');
  assert.equal(fetchCalls.length, 0);
  // a rejection reads the counters but must not move them
  assert.equal(storedUsage().globalDay, DEFAULT_LIMITS.globalDay);
});

test('step 5: a client at its hourly cap is rejected with its own scope', opts, async () => {
  seedBlobs({
    config: { geminiKey: 'k' },
    usage: liveUsage({ clientHour: { 'client-1': DEFAULT_LIMITS.perClientHour }, clientDay: { 'client-1': DEFAULT_LIMITS.perClientHour }, globalDay: DEFAULT_LIMITS.perClientHour }),
  });
  stubGemini(200, geminiJson([{ text: 'never' }]));
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).scope, 'client_hour');
  assert.equal(fetchCalls.length, 0);
});

test('step 7: an upstream failure answers 502 and the reservation is NOT refunded', opts, async () => {
  // fails closed on purpose (FINDINGS "Server functions"): a failed call
  // still spends the slot, so retry storms cannot mint free capacity
  seedBlobs({ config: { geminiKey: 'k' } });
  stubGemini(500, 'internal');
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream');
  assert.equal(storedUsage().globalDay, 1, 'quota stays spent');
});

test('step 7: an upstream 429 surfaces as quota_exceeded scope upstream', opts, async () => {
  seedBlobs({ config: { geminiKey: 'k' } });
  stubGemini(429, 'slow down');
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(body.scope, 'upstream');
});

test('step 8: an empty reply (safety block / all-thinking turn) answers 502, not a blank bubble', opts, async () => {
  seedBlobs({ config: { geminiKey: 'k' } });
  stubGemini(200, geminiJson([{ text: '' }, {}]));
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream');
});

test('step 7: an upstream abort (timeout) answers our JSON 502, not a crash', opts, async () => {
  // The plan-mode outage of 2026-08: the deadline fired mid-generation and the
  // resulting exception has to land as our {error:'upstream'} body, never as
  // an unhandled throw the platform turns into a gateway page.
  seedBlobs({ config: { geminiKey: 'k' } });
  fetchCalls = [];
  globalThis.fetch = async () => { throw new DOMException('The operation timed out', 'TimeoutError'); };
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream');
});

test('step 7: the 502 body never carries the key or the upstream response', opts, async () => {
  seedBlobs({ config: { geminiKey: 'secret-key-xyz' } });
  stubGemini(500, 'INTERNAL: model overloaded at backend host abc123');
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 502);
  const raw = await res.text();
  assert.equal(raw, JSON.stringify({ error: 'upstream' }), 'exactly the opaque error contract');
  assert.ok(!raw.includes('secret-key-xyz'));
  assert.ok(!raw.includes('abc123'));
});

test('upstream deadline: covers a full plan turn and sits inside both 60s windows', opts, async () => {
  // A plan-mode turn measured 8.3-14.1s live, and a full 12,000-token budget
  // is ~30-35s; 9s (the old upstreamSignal default) 502'd most plan turns.
  // The ceiling is Netlify's 60s synchronous limit and the browser's own 60s
  // abort, minus margin for our error path.
  assert.ok(ASSIST_UPSTREAM_TIMEOUT_MS >= 30000, 'must cover a full plan-mode generation');
  assert.ok(ASSIST_UPSTREAM_TIMEOUT_MS <= 50000, 'must answer before the platform and browser 60s cutoffs');
});

test('steps 5-9: the upstream call carries an abort deadline', opts, async () => {
  seedBlobs({ config: { geminiKey: 'k' } });
  stubGemini(200, geminiJson([{ text: 'ok' }]));
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 200);
  assert.ok(fetchCalls[0].init.signal instanceof AbortSignal, 'a hung upstream must not run to the platform kill');
});

test('step 9: a MAX_TOKENS reply still lands, carrying the visible truncation note', opts, async () => {
  seedBlobs({ config: { geminiKey: 'k' } });
  stubGemini(200, geminiJson([{ text: 'Half an answer' }], 'MAX_TOKENS'));
  const res = await handler(req(goodBody()));
  assert.equal(res.status, 200);
  const { reply } = await res.json();
  assert.ok(reply.startsWith('Half an answer'));
  assert.match(reply, /cut short/i);
});
