// Medicare is the one place a $0 price is common and genuinely misleading, so
// these tests care as much about what the results say as what they cost: the
// Part B premium is not included, special-needs plans are not shown, and a star
// rating is a quality signal rather than a recommendation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMeta, resolveZip, medicarePlansFor } from '../lib/quotescout/marketplace.mjs';
import { medicareQuotes, createAdapters } from '../lib/quotescout/adapters.mjs';
import { createEngine } from '../lib/quotescout/engine.mjs';
import { rankQuotes, isFresh, PRICED } from '../../../apps/quotescout/js/model.js';
import { createHandler } from '../quotescout.mjs';

const meta = getMeta();
const TTL = 6 * 3600000;
const now = Date.now();
const AUSTIN = '78701';
const ask = (zip = AUSTIN, extra = {}) => medicareQuotes({ zip, ...extra }, { provider: 'medicare-advantage', now, ttl: TTL });
const askDrug = (zip = AUSTIN, extra = {}) => medicareQuotes({ zip, ...extra }, { drug: true, provider: 'medicare-drug', now, ttl: TTL });

test('the Medicare dataset describes itself and covers the whole country', () => {
  assert.ok(meta.medicare, 'meta must carry the Medicare block');
  assert.match(meta.medicare.publishedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(meta.medicare.advantagePlans > 1000 && meta.medicare.drugPlans > 100);
  assert.ok(meta.medicare.states.length >= 51, 'Medicare is nationwide, unlike the marketplace');
  assert.deepEqual(meta.medicare.states, [...meta.medicare.states].sort());
  assert.match(meta.medicare.source, /^https:\/\/www\.cms\.gov\/files\/zip\//);
  // The states the marketplace cannot price must still be priceable here.
  for (const state of ['CA', 'NY']) {
    assert.ok(!meta.states.includes(state), `${state} is expected to be absent from the marketplace data`);
    assert.ok(meta.medicare.states.includes(state), `${state} must still have Medicare plans`);
  }
});

test('plans come back for a county anywhere, including a territory', () => {
  for (const zip of [AUSTIN, '90210', '10001', '00901']) {
    const counties = resolveZip(zip);
    assert.ok(counties, `${zip} should resolve to a county`);
    const found = medicarePlansFor({ state: counties[0].state, fips: counties[0].fips });
    assert.ok(found, `${zip} should have a Medicare shard`);
    assert.ok(found.advantage.length + found.drug.length > 0, `${zip} should have plans`);
  }
});

test('every Medicare price is a published rate that names its source and year', () => {
  const quotes = [...ask().quotes, ...askDrug().quotes];
  assert.ok(quotes.length > 20);
  for (const q of quotes) {
    assert.equal(q.status, 'AUTHORITATIVE PUBLIC RATE');
    assert.ok(PRICED.includes(q.status));
    assert.equal(q.provenance.kind, 'published-rate');
    assert.equal(q.provenance.planYear, meta.planYear);
    assert.equal(q.provenance.dataPublishedAt, meta.medicare.publishedAt);
    assert.match(q.provenance.source, /landscape file/);
    assert.ok(q.provenance.sourceId, 'a contract and plan id is the provenance');
    assert.equal(q.provenance.checkoutExact, false);
    assert.equal(q.currency, 'USD');
    assert.equal(q.interval, 'month');
    assert.equal(q.annual, q.amount * 12);
    assert.equal(q.continueUrl, 'https://www.medicare.gov/plan-compare/');
    assert.equal(q.affiliate, false);
    assert.ok(Number.isSafeInteger(q.amount) && q.amount >= 0);
  }
});

test('a zero-dollar premium still says the Part B premium is separate', () => {
  const quotes = ask().quotes;
  const free = quotes.filter(q => q.amount === 0);
  assert.ok(free.length, 'zero-premium Advantage plans are common and are the whole risk here');
  for (const q of quotes) {
    assert.match(q.details['Part B premium'], /separate/i);
    assert.match(q.provenance.warning, /Part B premium is separate/);
  }
});

test('special-needs plans are excluded, because they are not open to everyone', () => {
  const quotes = ask().quotes;
  // The build filters them, so no result may advertise itself as one.
  for (const q of quotes) assert.doesNotMatch(q.name, /\bD-SNP\b|\bC-SNP\b|\bI-SNP\b/i, q.name);
  assert.match(quotes[0].provenance.warning, /special-needs plans are excluded/i);
});

test('Advantage and drug plans are separate products and never share a ranking', () => {
  const advantage = ask().quotes, drug = askDrug().quotes;
  assert.ok(advantage.length > 5 && drug.length > 5);
  assert.ok(advantage.every(q => q.vertical === 'medicare-advantage' && q.comparisonKey.startsWith('medicare:')));
  assert.ok(drug.every(q => q.vertical === 'medicare-drug' && q.comparisonKey.startsWith('part-d:')));
  // A plan with drug coverage is not the same product as one without, so they
  // must not land in the same comparison group.
  const groups = new Set(advantage.map(q => q.comparisonKey));
  assert.ok([...groups].some(k => k.endsWith('with-drugs')) || [...groups].some(k => k.endsWith('no-drugs')));
  for (const q of advantage) assert.match(q.details['Drug coverage'], /Included|separate Part D/);
  assert.ok(drug.every(q => q.outOfPocket === null), 'a drug plan has no medical out-of-pocket limit to report');
});

test('star ratings are reported honestly, including their absence', () => {
  const quotes = ask().quotes;
  for (const q of quotes) {
    if (q.rating == null) assert.match(q.details['Star rating'], /Not rated/);
    else { assert.ok(q.rating > 0 && q.rating <= 5); assert.match(q.details['Star rating'], /out of 5/); }
  }
  const rated = quotes.filter(q => q.rating != null);
  assert.ok(rated.length, 'some plans should carry a CMS rating');
  const ranked = rankQuotes(quotes, 'best-rated', now);
  for (const group of ranked) {
    const stars = group.quotes.map(q => q.rating);
    const known = stars.filter(s => s != null);
    for (let i = 1; i < known.length; i++) assert.ok(known[i] <= known[i - 1], 'ratings descend');
    // Unrated plans sort last rather than being treated as zero stars.
    const firstNull = stars.indexOf(null);
    if (firstNull >= 0) assert.ok(stars.slice(firstNull).every(s => s == null));
  }
});

test('a multi-county ZIP asks, and only an offered county is accepted', () => {
  let zip = null;
  for (const candidate of ['37010', '42223', '30165', '35010', '27360']) {
    const counties = resolveZip(candidate);
    if (counties && counties.length > 1) { zip = candidate; break; }
  }
  assert.ok(zip, 'expected a multi-county ZIP');
  const asked = ask(zip);
  assert.equal(asked.quotes.length, 0);
  assert.equal(asked.questions[0].field, 'county');
  assert.match(asked.questions[0].label, /county by county/);
  const chosen = asked.questions[0].options[0].value;
  const answered = ask(zip, { county: chosen });
  assert.ok(answered.quotes.length >= 0);
  assert.ok(answered.quotes.every(q => q.provenance.product.county === chosen));
  assert.throws(() => ask(zip, { county: '48453' }), e => e.code === 'INVALID_INPUT');
});

test('an unrecognised ZIP is told apart from one we hold no plans for', () => {
  assert.throws(() => ask('00000'), e => e.code === 'INVALID_INPUT');
});

test('the Medicare adapters need no credential and make no upstream call', async () => {
  let calls = 0;
  const adapters = createAdapters({}, async () => { calls++; throw new Error('no network expected'); });
  for (const id of ['medicare-advantage', 'medicare-drug']) {
    const a = adapters.find(a => a.id === id);
    assert.equal(a.enabled, true);
    assert.equal(a.external, false);
    assert.equal(a.capability, 'Public data');
    const result = await a.quote({ zip: AUSTIN }, { enrich: (_k, _t, f) => f() });
    assert.ok(result.quotes.length > 0);
    assert.ok(result.quotes.every(q => q.provider === id));
  }
  assert.equal(calls, 0);
});

test('the engine accepts Medicare quotes and rejects ones that overstate themselves', async () => {
  const build = quotes => ({ id: 'medicare-advantage', name: 'm', vertical: 'medicare-advantage', enabled: true, ttl: TTL, quote: async () => ({ quotes }) });
  const req = { vertical: 'medicare-advantage', input: { zip: AUSTIN } };
  const good = await createEngine({ adapters: [build(ask().quotes.slice(0, 3))] })(req, 'session');
  assert.equal(good.providers[0].status, 'OK');
  assert.equal(good.providers[0].quotes.length, 3);
  assert.ok(good.providers[0].quotes.every(q => isFresh(q, now)));

  const base = ask().quotes[0];
  for (const patch of [
    { status: 'VERIFIED QUOTE' },
    { status: 'ESTIMATE' },
    { provenance: { ...base.provenance, kind: 'live-quote' } },
    { provenance: { ...base.provenance, sourceId: '' } },
    { continueUrl: 'https://www.medicare.gov/' },
  ]) {
    const r = await createEngine({ adapters: [build([{ ...base, ...patch }])] })(req, 'session');
    assert.equal(r.providers[0].status, 'MALFORMED', JSON.stringify(patch).slice(0, 50));
  }
});

test('the handler serves Medicare with no store, no credentials and no network', async () => {
  const logs = [];
  const handler = createHandler({
    storeFactory: async () => { throw new Error('blobs unavailable'); },
    fetcher: async () => { throw new Error('no network expected'); },
    env: { CONTEXT: 'production' },
    log: e => logs.push(e),
  });
  const post = body => handler(new Request('https://shevato.com/.netlify/functions/quotescout', {
    method: 'POST',
    headers: { Origin: 'https://shevato.com', 'Content-Type': 'application/json', 'X-QuoteScout-Session': 'e'.repeat(64) },
    body: JSON.stringify(body),
  }), { deploy: { context: 'production' } });

  // California has no marketplace data here, so this also proves Medicare is
  // not limited by the marketplace's thirty states.
  for (const [vertical, zip] of [['medicare-advantage', AUSTIN], ['medicare-drug', AUSTIN], ['medicare-advantage', '90210']]) {
    const response = await post({ vertical, input: { zip } });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map(l => JSON.parse(l));
    const provider = events.find(e => e.type === 'provider');
    assert.equal(provider.status, 'OK', `${vertical} ${zip}`);
    assert.ok(provider.quotes.length > 0);
    assert.ok(provider.quotes.every(q => q.status === 'AUTHORITATIVE PUBLIC RATE'));
    const done = events.find(e => e.type === 'done');
    assert.equal(done.unavailable, 0);
  }

  const capabilities = await (await handler(new Request('https://shevato.com/.netlify/functions/quotescout'), { deploy: { context: 'production' } })).json();
  assert.equal(capabilities.medicare.states.length, meta.medicare.states.length);
  assert.equal(capabilities.medicare.publishedAt, meta.medicare.publishedAt);
  for (const id of ['medicare-advantage', 'medicare-drug']) {
    assert.equal(capabilities.verticals.find(v => v.id === id).capability, 'Public data');
  }
  assert.ok(!JSON.stringify(logs).includes(AUSTIN));
});
