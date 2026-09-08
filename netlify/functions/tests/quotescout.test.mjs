// Platform behaviour: validation, orchestration, caching, quotas and the HTTP
// surface. The dataset-specific assertions live in quotescout-marketplace and
// quotescout-medicare; this file holds the engine to its contract using a
// synthetic quote, so it stays honest even as adapters come and go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vin, validateRequest, ScoutError } from '../lib/quotescout/validation.mjs';
import { createAdapters } from '../lib/quotescout/adapters.mjs';
import { createEngine, BoundedCache } from '../lib/quotescout/engine.mjs';
import { upstream, readJSON, deadline } from '../lib/quotescout/http.mjs';
import { reserveQuota, validateConfig } from '../lib/quotescout/store.mjs';
import { createHandler } from '../quotescout.mjs';

const VIN = '1HGCM82633A004352', now = Date.now(), TTL = 300000;
// Travis County TX: a single-county ZIP, so the happy path never depends on
// the additional-question branch.
const health = { zip: '78701', age: 27, tobacco: false, year: new Date().getUTCFullYear() };
const request = { vertical: 'health-insurance', input: health };

// A valid quote owing nothing to any particular adapter.
const quote = (extra = {}) => ({
  id: 'test:plan-1', provider: 'test', providerName: 'Test issuer', name: 'Test plan',
  vertical: 'health-insurance', amount: 20000, currency: 'USD', interval: 'month', annual: 240000,
  status: 'AUTHORITATIVE PUBLIC RATE',
  retrievedAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL).toISOString(),
  comparisonKey: 'health:Silver:HMO', comparisonLabel: 'Silver · HMO',
  provenance: { source: 'Test dataset', sourceId: 'plan-1', kind: 'published-rate', planYear: 2026, dataPublishedAt: '2025-10-15', transformations: ['none'], product: { test: true }, checkoutExact: false, warning: 'Test warning.' },
  ...extra,
});
const adapter = (id = 'test', fn = async () => ({ quotes: [quote()] })) => ({ id, name: id, vertical: 'health-insurance', enabled: true, ttl: TTL, quote: fn });
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function memoryStore(config = {}) {
  let revision = 0; const map = new Map([['config', config]]);
  return { map,
    async get(k) { return structuredClone(map.get(k)); },
    async getWithMetadata(k) { return map.has(k) ? { data: structuredClone(map.get(k)), etag: String(revision) } : null; },
    async setJSON(k, v, condition) { if ((condition.onlyIfMatch && condition.onlyIfMatch !== String(revision)) || (condition.onlyIfNew && map.has(k))) return { modified: false }; map.set(k, structuredClone(v)); revision++; return { modified: true }; } };
}

test('VIN normalization and check digit', () => {
  assert.equal(vin(' 1hgcm82633a004352 '), VIN);
  for (const v of ['', VIN.slice(1), VIN.replace('H', 'I'), VIN.replace('3A', '4A'), '<script>alert(1)</script>']) assert.throws(() => vin(v));
});

test('strict requests reject redundant, unknown and malicious inputs', () => {
  assert.deepEqual(validateRequest(request).input, health);
  for (const bad of [
    { ...request, input: { ...health, email: 'a@b.c' } },
    { ...request, input: { ...health, zip: '7870x' } },
    { ...request, provider: 'https://localhost' },
    { ...request, provider: 'easypost' },
    { ...request, refresh: 'yes' },
    { ...request, input: null },
    { ...request, vertical: 'invalid' },
    // Removed verticals must not linger as an accepted schema.
    { vertical: 'auto-insurance', input: { zip: '27360' } },
    { vertical: 'package-shipping', input: { originZip: '90210', destinationZip: '10001', weight: 16, length: 10, width: 5, height: 3 } },
  ]) assert.throws(() => validateRequest(bad), `${JSON.stringify(bad).slice(0, 60)} should be rejected`);
});

test('age, ZIP, county and tobacco boundary validation', () => {
  assert.equal(validateRequest({ ...request, input: { ...health, age: 18 } }).input.age, 18);
  for (const more of [{ age: 65 }, { age: 17 }, { age: 22.3 }, { tobacco: 'false' }, { county: 'bad' }, { year: 2020 }]) {
    assert.throws(() => validateRequest({ ...request, input: { ...health, ...more } }));
  }
  assert.equal(validateRequest({ vertical: 'vehicle-data', input: { vin: VIN } }).input.vin, VIN);
  // Medicare asks for a ZIP and nothing else; anything more is a mistake.
  assert.deepEqual(validateRequest({ vertical: 'medicare-advantage', input: { zip: '78701' } }).input, { zip: '78701' });
  assert.equal(validateRequest({ vertical: 'medicare-drug', input: { zip: '78701', county: '48453' } }).input.county, '48453');
  for (const bad of [{ zip: '78701', age: 70 }, { zip: '787011' }, { zip: '78701', tobacco: false }]) {
    assert.throws(() => validateRequest({ vertical: 'medicare-advantage', input: bad }));
  }
});

for (const code of ['TIMEOUT', 'RATE_LIMIT', 'AUTH', 'MALFORMED', 'INVALID_INPUT', 'UNSUPPORTED', 'UNAVAILABLE']) {
  test(`provider ${code} cannot discard successful peers`, async () => {
    const engine = createEngine({ adapters: [adapter(), adapter('bad', async () => { throw new ScoutError(code); })] });
    const r = await engine(request, 'a');
    assert.equal(r.summary.returned, 1);
    assert.equal(r.providers.find(p => p.provider === 'bad').status, code);
  });
}

test('bounded concurrency surfaces fast results without waiting for a slow provider', async () => {
  const order = []; let active = 0, max = 0;
  const adapters = Array.from({ length: 5 }, (_, i) => adapter(String(i), async () => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, i === 0 ? 30 : 1)); active--; return { quotes: [] }; }));
  await createEngine({ adapters, concurrency: 2 })(request, 'a', e => { if (e.type === 'provider') order.push(e.provider); });
  assert.equal(max, 2);
  assert.equal(order[0], '1');
});

test('timeout bounds an adapter that ignores cancellation', async () => {
  const r = await createEngine({ adapters: [adapter('slow', () => new Promise(() => {}))], timeout: 5 })(request, 'a');
  assert.equal(r.providers[0].status, 'TIMEOUT');
});

test('no provider, and duplicate registration or results, are explicit', async () => {
  assert.equal((await createEngine({ adapters: [] })(request, 'a')).summary.returned, 0);
  let calls = 0;
  const a = adapter('test', async () => { calls++; return { quotes: [quote(), quote()] }; });
  const r = await createEngine({ adapters: [a, a] })(request, 'a');
  assert.equal(calls, 1);
  assert.equal(r.summary.returned, 1);
});

test('additional questions return independently of prices', async () => {
  const r = await createEngine({ adapters: [adapter('test', async () => ({ quotes: [], questions: [{ field: 'county', label: 'County', options: [{ value: '12345', label: 'Test county' }] }] }))] })(request, 'a');
  assert.equal(r.providers[0].status, 'ADDITIONAL');
  assert.equal(r.summary.additional, 1);
});

test('cache is scoped by user and full inputs; refresh and expiry preserve retrieval time', async () => {
  let count = 0, time = now;
  const engine = createEngine({ adapters: [adapter('test', async () => { count++; return { quotes: [quote()] }; })], now: () => time, cache: new BoundedCache(50, () => time), enrichment: new BoundedCache(50, () => time) });
  const a = await engine(request, 'a');
  const b = await engine(request, 'a');
  assert.equal(b.providers[0].cached, true);
  assert.equal(a.providers[0].quotes[0].retrievedAt, b.providers[0].quotes[0].retrievedAt);
  await engine(request, 'b');
  await engine({ ...request, input: { ...health, age: 28 } }, 'a');
  await engine({ ...request, refresh: true }, 'a');
  assert.equal(count, 4);
  time += TTL + 1;
  const expired = await engine(request, 'a');
  assert.equal(count, 5);
  assert.equal(expired.providers[0].quotes[0].status, 'EXPIRED');
});

test('simultaneous identical requests deduplicate only within a session', async () => {
  let count = 0;
  const engine = createEngine({ adapters: [adapter('test', async () => { count++; await new Promise(r => setTimeout(r, 10)); return { quotes: [quote()] }; })] });
  await Promise.all([engine(request, 'a'), engine(request, 'a'), engine(request, 'b')]);
  assert.equal(count, 2);
});

test('circuit breaks after repeated transient failures', async () => {
  let count = 0;
  const engine = createEngine({ adapters: [adapter('test', async () => { count++; throw new ScoutError('UNAVAILABLE'); })] });
  for (let i = 0; i < 5; i++) await engine(request, String(i));
  assert.equal(count, 3);
});

test('bounded memory cache evicts, expires and hands back copies', () => {
  let time = 0;
  const cache = new BoundedCache(1, () => time);
  cache.set('a', { v: 1 }, 10); cache.set('b', { v: 2 }, 10);
  assert.equal(cache.get('a'), null);
  const b = cache.get('b'); b.v = 9;
  assert.equal(cache.get('b').v, 2);
  time = 10;
  assert.equal(cache.get('b'), null);
});

test('verification rejects invented provenance, foreign redirects and NaN prices', async () => {
  for (const patch of [
    { amount: NaN }, { provenance: {} }, { continueUrl: 'https://evil.example/' },
    { provider: 'other' }, { status: 'VERIFIED QUOTE' },
    { provenance: { ...quote().provenance, planYear: 'soon' } },
    { expiresAt: new Date(now + TTL * 5).toISOString() },
  ]) {
    const r = await createEngine({ adapters: [adapter('test', async () => ({ quotes: [{ ...quote(), ...patch }] }))] })(request, 'a');
    assert.equal(r.providers[0].status, 'MALFORMED', JSON.stringify(patch).slice(0, 60));
  }
});

test('both official handoffs are accepted, and nothing else is', async () => {
  for (const url of ['https://www.healthcare.gov/see-plans/', 'https://www.medicare.gov/plan-compare/']) {
    const r = await createEngine({ adapters: [adapter('test', async () => ({ quotes: [quote({ continueUrl: url })] }))] })(request, 'a');
    assert.equal(r.providers[0].status, 'OK', url);
  }
  for (const url of ['https://www.medicare.gov/', 'http://www.medicare.gov/plan-compare/', 'https://medicare.gov.evil.example/plan-compare/']) {
    const r = await createEngine({ adapters: [adapter('test', async () => ({ quotes: [quote({ continueUrl: url })] }))] })(request, 'a');
    assert.equal(r.providers[0].status, 'MALFORMED', url);
  }
});

test('a genuine adapter can still represent a verified live quote', async () => {
  const q = quote({ status: 'VERIFIED QUOTE', provenance: { ...quote().provenance, kind: 'live-quote' } });
  const r = await createEngine({ adapters: [adapter('test', async () => ({ quotes: [q] }))] })(request, 'a');
  assert.equal(r.providers[0].quotes[0].status, 'VERIFIED QUOTE');
});

test('upstream maps HTTP states, retries only safe GET and blocks redirects', async () => {
  for (const [status, code] of [[429, 'RATE_LIMIT'], [401, 'AUTH'], [403, 'AUTH'], [404, 'UNSUPPORTED'], [400, 'INVALID_INPUT'], [500, 'UNAVAILABLE']]) {
    await assert.rejects(upstream('https://example.test', { fetcher: async () => new Response('', { status }) }), e => e.code === code);
  }
  let calls = 0;
  await upstream('https://example.test', { fetcher: async (url, opts) => { assert.equal(opts.redirect, 'error'); return ++calls === 1 ? new Response('', { status: 503 }) : response({ ok: true }); } });
  assert.equal(calls, 2);
  await assert.rejects(upstream('https://example.test', { reserve: async () => false }), e => e.code === 'RATE_LIMIT');
});

test('response and request byte bounds reject large or malformed bodies', async () => {
  await assert.rejects(readJSON(new Response('x'.repeat(20)), 10));
  await assert.rejects(readJSON(new Response('{bad')));
  await assert.rejects(deadline(() => new Promise(() => {}), 2));
});

test('the VIN adapter only returns a successful authoritative decode', async () => {
  const ctx = { enrich: (_k, _t, f) => f() };
  const ok = createAdapters({}, async () => response({ Results: [{ ErrorCode: '0', Make: 'HONDA', Model: 'Accord', ModelYear: '2003' }] })).find(a => a.id === 'vpic');
  assert.equal((await ok.quote({ vin: VIN }, ctx)).vehicle.make, 'HONDA');
  const bad = createAdapters({}, async () => response({ Results: [{ ErrorCode: '7', Make: 'HONDA', Model: 'Accord', ModelYear: '2003' }] })).find(a => a.id === 'vpic');
  await assert.rejects(bad.quote({ vin: VIN }, ctx));
});

test('no adapter carries a credential, and configuration admits none', () => {
  assert.deepEqual(validateConfig(), {});
  const adapters = createAdapters({}, async () => { throw new Error('no network expected'); });
  assert.deepEqual(adapters.map(a => a.id).sort(), ['cms-puf', 'cms-puf-dental', 'medicare-advantage', 'medicare-drug', 'vpic']);
  assert.ok(adapters.every(a => a.enabled), 'every shipped adapter works without configuration');
  // Only the one that calls out is metered; the datasets travel with the code.
  assert.deepEqual(adapters.filter(a => a.external).map(a => a.id), ['vpic']);
});

test('quota CAS admits at most remaining capacity under races and fails closed', async () => {
  const store = memoryStore();
  const results = await Promise.all(Array.from({ length: 40 }, () => reserveQuota(store, 'same', 'vpic', now)));
  assert.ok(results.filter(Boolean).length <= 30);
  const usage = await store.get('usage');
  assert.ok(!JSON.stringify(usage).includes('same'), 'identities are hashed, never stored raw');
  assert.ok(usage.monthly <= 30);
  await assert.rejects(reserveQuota({ ...store, setJSON: async () => undefined }, 'other', 'vpic', now));
});

const httpRequest = (body = request, headers = {}, method = 'POST') => new Request('https://shevato.com/.netlify/functions/quotescout', {
  method,
  headers: { Origin: 'https://shevato.com', 'Content-Type': 'application/json', 'X-QuoteScout-Session': 'a'.repeat(64), ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
});

test('API guards, no-store headers and log redaction', async () => {
  const logs = [], store = memoryStore();
  const handler = createHandler({ storeFactory: async () => store, env: { CONTEXT: 'production' }, log: e => logs.push(e) });
  const get = await handler(httpRequest(undefined, {}, 'GET'));
  assert.match(get.headers.get('cache-control'), /no-store/);
  const data = await get.json();
  assert.ok(data.verticals.every(v => v.capability === 'Public data'), 'every listed category is live');
  assert.equal((await handler(httpRequest(request, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await handler(httpRequest({ ...request, input: { vin: VIN } }))).status, 400);
  assert.equal((await handler(httpRequest(request, { 'X-QuoteScout-Session': 'bad' }))).status, 400);
  assert.equal((await handler(httpRequest(request, { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await handler(httpRequest(undefined, {}, 'DELETE'))).status, 405);
  const r = await handler(httpRequest(), { ip: '192.0.2.1' });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /AUTHORITATIVE PUBLIC RATE/);
  assert.ok(!JSON.stringify(logs).includes(VIN));
  assert.ok(!JSON.stringify(logs).includes('192.0.2.1'));
  assert.ok(!JSON.stringify(logs).includes('78701'), 'the ZIP never reaches the logs');
});

test('a store outage cannot spend money and degrades only what calls out', async () => {
  let calls = 0;
  const handler = createHandler({ storeFactory: async () => { throw new Error('secret'); }, fetcher: async () => { calls++; }, log: () => {} });
  const data = await (await handler(httpRequest(undefined, {}, 'GET'))).json();
  assert.equal(data.vehicleData, false, 'vPIC calls out, so it is withheld without a meter');
  assert.ok(data.verticals.every(v => v.capability === 'Public data'), 'the bundled datasets keep working');
  const r = await handler(httpRequest(), { ip: '192.0.2.1' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /AUTHORITATIVE PUBLIC RATE/);
  assert.equal(calls, 0, 'no upstream call may happen while the usage store is down');
  assert.ok(!JSON.stringify(await (await handler(httpRequest(undefined, {}, 'GET'))).json()).includes('secret'));
});

test('VIN enrichment caches validated fields only and recovers after a malformed response', async () => {
  let calls = 0;
  const enrichment = new BoundedCache();
  const adapters = createAdapters({}, async () => { calls++; return response({ Results: [calls === 1 ? { ErrorCode: '7' } : { ErrorCode: '0', VIN, Make: 'HONDA', Model: 'Accord', ModelYear: '2003' }] }); });
  const engine = createEngine({ adapters, enrichment });
  const r = { vertical: 'vehicle-data', input: { vin: VIN } };
  assert.equal((await engine(r, 'a')).providers[0].status, 'UNSUPPORTED');
  assert.equal((await engine(r, 'a')).providers[0].vehicle.make, 'HONDA');
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify([...enrichment.entries.values()].map(e => e.data)).includes(VIN));
});

test('a same-deploy preview can use the free tools without a production origin', async () => {
  const handler = createHandler({ storeFactory: async () => memoryStore(), env: {}, log: () => {}, fetcher: async () => response({ Results: [{ ErrorCode: '0', Make: 'HONDA', Model: 'Accord', ModelYear: '2003' }] }) });
  const origin = 'https://deploy-preview-999--shevato.netlify.app';
  const req = new Request(`${origin}/.netlify/functions/quotescout`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-QuoteScout-Session': 'c'.repeat(64) }, body: JSON.stringify({ vertical: 'vehicle-data', input: { vin: VIN } }) });
  const r = await handler(req, { ip: '192.0.2.9', deploy: { context: 'deploy-preview' } });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /HONDA/);
});
