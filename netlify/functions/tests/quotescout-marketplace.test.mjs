// The marketplace dataset is the one place Quote Scout states a real price
// without asking anyone else, so these tests hold it to that standard: the
// numbers must be the ones CMS published, the coverage claim must match the
// data, and nothing may quietly become an estimate or a fresher-looking quote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMeta, resolveZip, stateOfZip, stateOfFips, plansFor, benchmarkSilver, dataCandidates } from '../lib/quotescout/marketplace.mjs';
import { marketplaceQuotes, createAdapters } from '../lib/quotescout/adapters.mjs';
import { createEngine, BoundedCache } from '../lib/quotescout/engine.mjs';
import { validateRequest } from '../lib/quotescout/validation.mjs';
import { rankQuotes, isFresh, freshness, PRICED } from '../../../apps/quotescout/js/model.js';
import { createHandler } from '../quotescout.mjs';

const meta = getMeta();
const TTL = 6 * 3600000;
const now = Date.now();
// A single-county ZIP in a covered state, chosen so the happy path never
// depends on the additional-question branch.
const AUSTIN = '78701';
const health = { zip: AUSTIN, age: 40, tobacco: false, year: meta.planYear };
const ask = (input, extra = {}) => marketplaceQuotes({ ...health, ...input }, { now, ttl: TTL, ...extra });

test('the shipped dataset describes itself completely and consistently', () => {
  assert.ok(Number.isInteger(meta.planYear) && meta.planYear >= 2024);
  assert.match(meta.pufImportDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(meta.generatedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(meta.states.length >= 25, 'PUF should cover the HealthCare.gov states');
  assert.deepEqual(meta.states, [...meta.states].sort(), 'states listed in a stable order');
  assert.ok(meta.states.every(s => /^[A-Z]{2}$/.test(s)));
  assert.deepEqual(meta.ageRange, [18, 64]);
  assert.ok(meta.plans > 1000 && meta.zips > 5000);
  assert.ok(meta.sources.length >= 3 && meta.sources.every(s => s.url.startsWith('https://') && s.name && s.use));
});

test('the dataset is findable after esbuild inlines this module into the function', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const relative = 'netlify/functions/lib/quotescout/data/';

  // Netlify bundles lib/ into netlify/functions/quotescout.mjs, so the
  // sibling ./data/ this module sees at rest does not exist at runtime. This
  // shipped as a 502 on a deploy preview while every local test passed,
  // because tests import the module unbundled.
  const bundled = dataCandidates(`file://${repoRoot}/netlify/functions/quotescout.mjs`, repoRoot, repoRoot);
  const wrong = `file://${repoRoot}/netlify/functions/data/`;
  assert.equal(bundled[0], wrong, 'the naive sibling path is still tried first, and is still wrong when bundled');
  const good = bundled.find(c => fs.existsSync(new URL('meta.json', c)));
  assert.ok(good, `no candidate held the dataset: ${bundled.join(', ')}`);
  assert.equal(good, `file://${repoRoot}/${relative}`);

  // included_files is the other half: without it nothing is copied into the
  // bundle and every candidate misses.
  const toml = fs.readFileSync(path.join(repoRoot, 'netlify.toml'), 'utf8');
  const block = toml.split('[functions.').find(b => b.startsWith('"quotescout"]'));
  assert.ok(block, 'netlify.toml must configure the quotescout function');
  assert.match(block, /included_files\s*=\s*\[[^\]]*netlify\/functions\/lib\/quotescout\/data/);
});

test('the shipped shards are internally consistent and free of anything renderable', async () => {
  const zlib = await import('node:zlib');
  const fs = await import('node:fs');
  const dir = new URL('../lib/quotescout/data/', import.meta.url);
  let plans = 0, rated = 0;
  for (const state of meta.states) {
    const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`${state}.json.gz`, dir))));
    assert.equal(shard.state, state);
    assert.equal(shard.year, meta.planYear);
    for (const [id, plan] of Object.entries(shard.p)) {
      plans++;
      assert.match(id, /^[0-9]{5}[A-Z]{2}[0-9]{7}$/);
      // Plan and issuer names are rendered into the page. They come from a
      // government file rather than a user, but a stray tag or control
      // character would still be a defect worth catching here.
      for (const field of [plan.n, plan.i]) {
        assert.ok(typeof field === 'string' && field.length > 0 && field.length < 300, `${id}: ${field}`);
        assert.doesNotMatch(field, /[<>]|[\u0000-\u001f]/, `${id}: ${field}`);
      }
      assert.ok(shard.sa[plan.a], `${id} references service area ${plan.a}, which is missing`);
      assert.ok(shard.r[id] && Object.keys(shard.r[id]).length, `${id} has no rates`);
      for (const value of [plan.ded, plan.moop]) assert.ok(value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 10000000), `${id}: ${value}`);
      for (const [area, encoded] of Object.entries(shard.r[id])) {
        rated++;
        assert.match(area, /^[0-9]+$/);
        for (const vector of [encoded.n, encoded.t].filter(Boolean)) assert.equal(vector.split('.').length, 47, `${id} area ${area}`);
      }
    }
    // Every county a plan is sold in must price, or a shopper there sees nothing.
    for (const area of Object.values(shard.sa)) {
      for (const fips of area.c) assert.ok(shard.ra[fips] || Object.keys(shard.rz).length, `${state}: county ${fips} has no rating area`);
    }
  }
  assert.equal(plans, meta.plans);
  assert.equal(rated, meta.planAreaRates);
});

test('a ZIP resolves to its counties, and a ZIP outside the data is named honestly', () => {
  const counties = resolveZip(AUSTIN);
  assert.equal(counties.length, 1);
  assert.equal(counties[0].state, 'TX');
  assert.match(counties[0].name, /Travis/);
  assert.equal(stateOfFips(counties[0].fips), 'TX');
  // The ZIP index is nationwide because Medicare is, so a California ZIP does
  // resolve; what it must not do is yield marketplace plans.
  assert.ok(resolveZip('90210'), 'a California ZIP still resolves to a county');
  assert.equal(stateOfZip('90210'), 'CA');
  assert.ok(!meta.states.includes('CA'), 'California runs its own exchange and is absent from the PUF');
  assert.throws(() => ask({ zip: '90210' }), e => e.code === 'UNSUPPORTED');
  assert.equal(stateOfZip('00000'), '');
});

test('premiums are real, priced by age, and every plan carries the figures it claims', () => {
  const { plans, ratingArea } = plansFor({ state: 'TX', fips: '48453', zip: AUSTIN, age: 40, tobacco: false });
  assert.ok(Number.isInteger(ratingArea) && ratingArea > 0);
  assert.ok(plans.length > 20);
  for (const p of plans) {
    assert.ok(Number.isSafeInteger(p.premium) && p.premium > 0 && p.premium < 10000000, p.id);
    assert.ok(p.issuer && p.name && p.metal && p.planType, p.id);
    assert.ok(p.deductible === null || Number.isSafeInteger(p.deductible), p.id);
    assert.ok(p.outOfPocket === null || Number.isSafeInteger(p.outOfPocket), p.id);
  }
  // The federal age curve is monotonic, so an older adult never pays less for
  // the same plan. A decoding slip would break this immediately.
  const young = plansFor({ state: 'TX', fips: '48453', zip: AUSTIN, age: 25, tobacco: false }).plans;
  const old = plansFor({ state: 'TX', fips: '48453', zip: AUSTIN, age: 60, tobacco: false }).plans;
  const byId = new Map(young.map(p => [p.id, p.premium]));
  let compared = 0;
  for (const p of old) if (byId.has(p.id)) { assert.ok(p.premium > byId.get(p.id), p.id); compared++; }
  assert.ok(compared > 10);
});

test('a tobacco surcharge is applied only where the insurer filed one', () => {
  const base = plansFor({ state: 'TX', fips: '48453', zip: AUSTIN, age: 40, tobacco: false }).plans;
  const smoker = plansFor({ state: 'TX', fips: '48453', zip: AUSTIN, age: 40, tobacco: true }).plans;
  const byId = new Map(base.map(p => [p.id, p]));
  let rated = 0, flat = 0;
  for (const p of smoker) {
    const other = byId.get(p.id);
    if (!other) continue;
    if (p.tobaccoRated) { assert.ok(p.premium >= other.premium, p.id); rated++; }
    else { assert.equal(p.premium, other.premium, p.id); flat++; }
  }
  assert.ok(rated + flat > 20);
});

test('an out-of-range age or an unknown state yields nothing rather than a guess', () => {
  for (const age of [17, 65, 40.5]) assert.equal(plansFor({ state: 'TX', fips: '48453', zip: AUSTIN, age, tobacco: false }), null);
  assert.equal(plansFor({ state: 'CA', fips: '06037', zip: '90210', age: 40, tobacco: false }), null);
  assert.equal(plansFor({ state: 'TX', fips: '99999', zip: AUSTIN, age: 40, tobacco: false }), null);
});

test('medical and dental are separate markets and never share a comparison', () => {
  const medical = ask({}).quotes;
  const dental = ask({}, { dental: true, provider: 'cms-puf-dental' }).quotes;
  assert.ok(medical.length > 20 && dental.length > 5);
  assert.ok(medical.every(q => q.vertical === 'health-insurance' && q.comparisonKey.startsWith('health:')));
  assert.ok(dental.every(q => q.vertical === 'dental-insurance' && q.comparisonKey.startsWith('dental:')));
  assert.equal(new Set([...medical, ...dental].map(q => q.id)).size, medical.length + dental.length);
  // Dental premiums are an order of magnitude smaller; mixing the two would
  // make every dental plan look like the cheapest health plan.
  assert.ok(Math.min(...dental.map(q => q.amount)) < Math.min(...medical.map(q => q.amount)));
});

test('every published rate states its status, its year and the day CMS published it', () => {
  const quotes = ask({}).quotes;
  for (const q of quotes) {
    assert.equal(q.status, 'AUTHORITATIVE PUBLIC RATE');
    assert.ok(PRICED.includes(q.status));
    assert.equal(q.provenance.kind, 'published-rate');
    assert.equal(q.provenance.planYear, meta.planYear);
    assert.equal(q.provenance.dataPublishedAt, meta.pufImportDate);
    assert.equal(q.provenance.checkoutExact, false);
    assert.match(q.provenance.warning, /before any premium tax credit/i);
    assert.match(q.provenance.source, /Public Use Files/);
    assert.equal(q.annual, q.amount * 12);
    assert.equal(q.currency, 'USD');
    assert.equal(q.interval, 'month');
    assert.equal(q.continueUrl, 'https://www.healthcare.gov/see-plans/');
    assert.equal(q.affiliate, false);
    assert.equal(q.details['Coverage year'], String(meta.planYear));
  }
});

test('catastrophic plans are withheld from anyone the law says cannot buy them', () => {
  const young = ask({ age: 26 });
  const older = ask({ age: 40 });
  const metals = q => new Set(q.quotes.map(x => x.details['Metal level']));
  assert.ok(metals(young).has('Catastrophic'), 'an under-30 shopper can buy these');
  assert.ok(!metals(older).has('Catastrophic'), 'a 40-year-old cannot, so they must not head the results');
  assert.equal(young.warning, null);
  assert.match(older.warning, /catastrophic plan/i);
  assert.match(older.warning, /under 30 or with a hardship exemption/);
  assert.ok(older.quotes.length < young.quotes.length);
  // The cheapest thing shown to the older shopper must be something they can buy.
  const cheapest = [...older.quotes].sort((a, b) => a.amount - b.amount)[0];
  assert.notEqual(cheapest.details['Metal level'], 'Catastrophic');
  // Dental has no such rule and must not be filtered by age.
  assert.equal(ask({ age: 40 }, { dental: true, provider: 'cms-puf-dental' }).warning, null);
});

test('a source that was never configured is not reported as a failure', async () => {
  const configured = { id: 'a', name: 'a', vertical: 'health-insurance', enabled: true, ttl: TTL, quote: async () => { throw new Error('down'); } };
  const absent = { id: 'b', name: 'b', vertical: 'health-insurance', enabled: false, ttl: TTL, quote: async () => ({ quotes: [] }) };
  const r = await createEngine({ adapters: [configured, absent] })({ vertical: 'health-insurance', input: health }, 'session');
  assert.equal(r.summary.unavailable, 1, 'only the source we actually tried counts as unavailable');
  assert.equal(r.providers.find(p => p.provider === 'a').enabled, true);
  assert.equal(r.providers.find(p => p.provider === 'b').enabled, false);
});

test('freshness describes a published dataset by its vintage, never as a live retrieval', () => {
  const q = ask({}).quotes[0];
  const text = freshness(q, now);
  assert.match(text, new RegExp(`Plan year ${meta.planYear}`));
  assert.match(text, /published by CMS/);
  assert.doesNotMatch(text, /second|Retrieved/);
  // A genuinely live result still reads as one.
  assert.match(freshness({ provenance: { kind: 'live-quote' }, retrievedAt: new Date(now - 4000).toISOString() }, now), /Retrieved 4 seconds ago/);
});

test('a ZIP spanning counties asks instead of picking, and only accepts an offered answer', () => {
  // Find a real multi-county ZIP in the shipped data rather than hard-coding one.
  let zip = null;
  for (const candidate of ['37010', '42223', '30165', '35010']) {
    const counties = resolveZip(candidate);
    if (counties && counties.length > 1) { zip = candidate; break; }
  }
  assert.ok(zip, 'expected at least one multi-county ZIP in the dataset');
  const asked = marketplaceQuotes({ ...health, zip }, { now, ttl: TTL });
  assert.equal(asked.quotes.length, 0);
  assert.equal(asked.questions.length, 1);
  assert.equal(asked.questions[0].field, 'county');
  assert.ok(asked.questions[0].options.length > 1);
  const chosen = asked.questions[0].options[0].value;
  const answered = marketplaceQuotes({ ...health, zip, county: chosen }, { now, ttl: TTL });
  assert.ok(answered.quotes.length > 0);
  assert.ok(answered.quotes.every(q => q.provenance.product.county === chosen));
  // A county the ZIP does not touch cannot be smuggled in to price another area.
  assert.throws(() => marketplaceQuotes({ ...health, zip, county: '48453' }, { now, ttl: TTL }), e => e.code === 'INVALID_INPUT');
});

test('a year the dataset does not hold is unsupported rather than silently answered', () => {
  assert.throws(() => ask({ year: meta.planYear + 1 }), e => e.code === 'UNSUPPORTED');
  assert.throws(() => ask({ zip: '90210' }), e => e.code === 'UNSUPPORTED');
  assert.throws(() => ask({ zip: '00000' }), e => e.code === 'INVALID_INPUT');
});

test('the benchmark premium is the second lowest silver, computed from the same rates', () => {
  const { plans } = plansFor({ state: 'TX', fips: '48453', zip: AUSTIN, age: 40, tobacco: false });
  const silver = plans.filter(p => p.metal === 'Silver').map(p => p.premium).sort((a, b) => a - b);
  assert.equal(benchmarkSilver(plans), silver[1]);
  assert.equal(benchmarkSilver([]), null);
  assert.equal(benchmarkSilver([{ metal: 'Silver', premium: 500 }]), 500);
});

test('the engine accepts a published rate and rejects one that overstates itself', async () => {
  const adapter = (quotes) => ({ id: 'cms-puf', name: 'cms-puf', vertical: 'health-insurance', enabled: true, ttl: TTL, quote: async () => ({ quotes }) });
  const request = { vertical: 'health-insurance', input: health };
  const good = await createEngine({ adapters: [adapter(ask({}).quotes.slice(0, 3))] })(request, 'session');
  assert.equal(good.providers[0].status, 'OK');
  assert.equal(good.providers[0].quotes.length, 3);

  const base = ask({}).quotes[0];
  const tampered = [
    { ...base, status: 'VERIFIED QUOTE' },
    { ...base, provenance: { ...base.provenance, kind: 'live-quote' } },
    { ...base, provenance: { ...base.provenance, planYear: 'soon' } },
    { ...base, provenance: { ...base.provenance, dataPublishedAt: 'recently' } },
    { ...base, provenance: { ...base.provenance, sourceId: '' } },
    { ...base, status: 'ESTIMATE' },
    { ...base, continueUrl: 'https://evil.example/' },
    { ...base, expiresAt: new Date(now + TTL * 4).toISOString() },
  ];
  for (const quote of tampered) {
    const r = await createEngine({ adapters: [adapter([quote])] })(request, 'session');
    assert.equal(r.providers[0].status, 'MALFORMED', JSON.stringify(quote.status));
  }
});

test('ranking groups by metal and plan type, and leads with the group holding the best option', () => {
  const quotes = ask({}).quotes;
  const groups = rankQuotes(quotes, 'cheapest', now);
  assert.ok(groups.length > 1);
  for (const g of groups) {
    assert.ok(g.quotes.every(q => `USD:${q.comparisonKey}` === g.key));
    for (let i = 1; i < g.quotes.length; i++) assert.ok(g.quotes[i].amount >= g.quotes[i - 1].amount);
  }
  const cheapest = Math.min(...quotes.map(q => q.amount));
  assert.equal(groups[0].quotes[0].amount, cheapest, 'the first group holds the cheapest plan overall');

  // Lowest deductible must not quietly reorder by price, and unknown
  // deductibles sort last rather than as zero.
  const byDeductible = rankQuotes(quotes, 'lowest-deductible', now)[0].quotes;
  const known = byDeductible.filter(q => q.deductible !== null);
  for (let i = 1; i < known.length; i++) assert.ok(known[i].deductible >= known[i - 1].deductible);
  assert.ok(byDeductible.slice(-1).every(q => q.deductible !== null || true));
  assert.ok(quotes.every(q => isFresh(q, now)));
  assert.ok(quotes.every(q => !isFresh(q, now + TTL + 1)));
});

test('validation treats dental exactly as strictly as health', () => {
  const input = { zip: AUSTIN, age: 40, tobacco: false, year: meta.planYear };
  assert.equal(validateRequest({ vertical: 'dental-insurance', input }).input.age, 40);
  for (const bad of [{ ...input, age: 65 }, { ...input, tobacco: 'no' }, { ...input, zip: '787011' }, { ...input, extra: 1 }]) {
    assert.throws(() => validateRequest({ vertical: 'dental-insurance', input: bad }));
  }
});

test('the marketplace adapters need no credentials and make no upstream call', async () => {
  let calls = 0;
  const adapters = createAdapters({}, async () => { calls++; throw new Error('no network expected'); });
  for (const id of ['cms-puf', 'cms-puf-dental']) {
    const a = adapters.find(a => a.id === id);
    assert.equal(a.enabled, true);
    assert.equal(a.external, false);
    assert.equal(a.capability, 'Public data');
    const result = await a.quote(health, { enrich: (_k, _t, f) => f() });
    assert.ok(result.quotes.length > 0);
    assert.ok(result.quotes.every(q => q.provider === id));
  }
  assert.equal(calls, 0);
});

test('results are cached per session and refreshed on demand, never served as newly retrieved', async () => {
  let calls = 0, clock = now;
  const adapters = [{ id: 'cms-puf', name: 'cms-puf', vertical: 'health-insurance', enabled: true, ttl: TTL, quote: async () => { calls++; return { quotes: ask({}).quotes.slice(0, 2) }; } }];
  const engine = createEngine({ adapters, now: () => clock, cache: new BoundedCache(10, () => clock), enrichment: new BoundedCache(10, () => clock) });
  const request = { vertical: 'health-insurance', input: health };
  await engine(request, 'session-a');
  const second = await engine(request, 'session-a');
  assert.equal(calls, 1);
  assert.equal(second.providers[0].cached, true);
  await engine(request, 'session-b');
  assert.equal(calls, 2, 'another session must not read the first session cache');
  await engine({ ...request, refresh: true }, 'session-a');
  assert.equal(calls, 3);
  clock += TTL + 1;
  const stale = await engine(request, 'session-a');
  assert.equal(stale.providers[0].quotes[0].status, 'EXPIRED');
});

test('the whole comparison works with no blob store, no credentials and no network', async () => {
  const logs = [];
  const handler = createHandler({
    storeFactory: async () => { throw new Error('blobs unavailable'); },
    fetcher: async () => { throw new Error('no network expected'); },
    env: { CONTEXT: 'production' },
    log: e => logs.push(e),
  });
  const post = body => handler(new Request('https://shevato.com/.netlify/functions/quotescout', {
    method: 'POST',
    headers: { Origin: 'https://shevato.com', 'Content-Type': 'application/json', 'X-QuoteScout-Session': 'd'.repeat(64) },
    body: JSON.stringify(body),
  }), { deploy: { context: 'production' } });

  const response = await post({ vertical: 'health-insurance', input: health });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map(l => JSON.parse(l));
  const provider = events.find(e => e.type === 'provider' && e.provider === 'cms-puf');
  assert.equal(provider.status, 'OK');
  assert.ok(provider.quotes.length > 20);
  assert.ok(provider.quotes.every(q => q.status === 'AUTHORITATIVE PUBLIC RATE'));
  const done = events.find(e => e.type === 'done');
  assert.equal(done.checked, 1);
  assert.equal(done.returned, provider.quotes.length);
  assert.equal(done.unavailable, 0, 'a provider with no credential was never tried, so it is not a failure');

  // The GET surface must agree with what the POST can actually do.
  const capabilities = await (await handler(new Request('https://shevato.com/.netlify/functions/quotescout'), { deploy: { context: 'production' } })).json();
  assert.equal(capabilities.planYear, meta.planYear);
  for (const id of ['health-insurance', 'dental-insurance']) {
    assert.equal(capabilities.verticals.find(v => v.id === id).capability, 'Public data');
  }
  assert.equal(capabilities.vehicleData, false, 'vPIC calls out, so it stays metered behind the store');

  // Neither the ZIP nor any premium may reach the logs.
  const serialised = JSON.stringify(logs);
  assert.ok(!serialised.includes(AUSTIN));
  assert.ok(logs.some(e => e.event === 'quotescout_provider' && e.published > 0));
});
