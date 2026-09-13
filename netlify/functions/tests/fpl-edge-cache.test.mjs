// How long Netlify's CDN may repeat an FPL proxy answer, near a deadline.
//
// THE BUG (2026-09-12 audit Q-1). Inside the six hours before a deadline the
// proxy collapses every TTL to 120 s, because that is when prices, injury news
// and team news move. The function honoured that; the EDGE header did not:
// edgeCachePolicy asked ttlSeconds() for the TTL with `nextDeadline: null`, so
// it always got the base TTL, and emitted max-age=600 for bootstrap-static
// (fixtures 1800, entry 300) in the one window the collapse exists for. A copy
// the CDN repeats is never re-evaluated by the function, and it carries the
// `x-fpl-age-seconds` it had when stored, so the planner was shown numbers up
// to ten minutes old as fresh.
//
// The rule these pin: for every second the edge may serve a copy, the copy's
// data age stays below the TTL the function itself would apply at that
// second. Outside the window that is the base TTL; inside it, the collapsed
// one; and a copy stored just before the window opens must not be carried
// into it at the base TTL either.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { edgeCachePolicy } from '../fpl.mjs';
import {
  ttlSeconds, cacheKey, TTL, DEADLINE_KEY, DEADLINE_WINDOW_MS, DEADLINE_TTL_SECONDS,
} from '../lib/fpl-cache.mjs';

const NOW = Date.parse('2026-09-19T11:00:00Z');
const SEC = 1000;
const PATHS = {
  bootstrap: 'bootstrap-static',
  fixtures: 'fixtures',
  entry: 'entry/4231987/history',
  'element-summary': 'element-summary/328',
  live: 'event/4/live',
};
const iso = ms => new Date(ms).toISOString();
const maxAge = policy => (policy === 'no-store' ? 0 : Number(/max-age=(\d+)/.exec(policy)[1]));
const fresh = (path, ageSeconds, nextDeadline) => ({ status: 200, stale: false, path, ageSeconds, nextDeadline });

// ------------------------------------------------------------ pure policy ---

test('far from any deadline the edge window is the base TTL for every path class', () => {
  const deadline = iso(NOW + 3 * 24 * 3600 * SEC);
  for (const [kind, path] of Object.entries(PATHS)) {
    assert.equal(edgeCachePolicy(fresh(path, 0, deadline), NOW), `public, max-age=${TTL[kind]}`, kind);
  }
});

test('with no deadline known the edge window is the base TTL, exactly as the function applies it', () => {
  for (const [kind, path] of Object.entries(PATHS)) {
    assert.equal(edgeCachePolicy(fresh(path, 0, null), NOW), `public, max-age=${TTL[kind]}`, kind);
  }
});

test('inside the six-hour window the edge window collapses for every path class', () => {
  const deadline = iso(NOW + 2 * 3600 * SEC);
  for (const [kind, path] of Object.entries(PATHS)) {
    const expected = Math.min(TTL[kind], DEADLINE_TTL_SECONDS);
    assert.equal(edgeCachePolicy(fresh(path, 0, deadline), NOW), `public, max-age=${expected}`, kind);
  }
});

test('inside the window the copy\'s own age still comes off, and a nearly expired copy is not pinned', () => {
  const deadline = iso(NOW + 2 * 3600 * SEC);
  assert.equal(edgeCachePolicy(fresh('fixtures', 30, deadline), NOW), 'public, max-age=90');
  assert.equal(edgeCachePolicy(fresh('bootstrap-static', 116, deadline), NOW), 'no-store');
});

test('boundary: just AFTER the six-hour mark (inside the window) the collapsed TTL applies', () => {
  for (const offset of [0, 1]) {
    const deadline = iso(NOW + DEADLINE_WINDOW_MS - offset * SEC);
    assert.equal(edgeCachePolicy(fresh('fixtures', 0, deadline), NOW), 'public, max-age=120', `6h - ${offset}s`);
  }
});

test('boundary: just BEFORE the six-hour mark a fresh copy is not carried into the window at the base TTL', () => {
  // The window opens one second from now. max-age=1800 would let the CDN hand
  // this copy out for 29 minutes of the window.
  const deadline = iso(NOW + DEADLINE_WINDOW_MS + 1 * SEC);
  assert.equal(edgeCachePolicy(fresh('fixtures', 0, deadline), NOW), 'public, max-age=120');
  // An older copy that would already be past 120 s when the window opens stops
  // at the window instead.
  const later = iso(NOW + DEADLINE_WINDOW_MS + 300 * SEC);
  assert.equal(edgeCachePolicy(fresh('fixtures', 200, later), NOW), 'public, max-age=300');
  // And with the window further away than the base TTL nothing changes.
  const far = iso(NOW + DEADLINE_WINDOW_MS + 3600 * SEC);
  assert.equal(edgeCachePolicy(fresh('bootstrap-static', 0, far), NOW), 'public, max-age=600');
});

test('THE INVARIANT: no second of the edge window serves data the function would call expired', () => {
  // Exhaustive over the shapes that matter: every path class, copies of many
  // ages, deadlines inside the window, at its edge, just outside it and far
  // away. For each, walk every second the edge is allowed to serve and ask the
  // function's own TTL rule about the data at that moment.
  const ages = [0, 1, 30, 59, 60, 100, 119, 200, 299, 599, 899, 1799];
  const windowOffsets = [-7200, -1, 0, 1, 30, 60, 119, 120, 121, 300, 599, 600, 601, 1800, 3600];
  let checked = 0;
  for (const [kind, path] of Object.entries(PATHS)) {
    for (const age of ages) {
      if (age >= TTL[kind]) continue;
      for (const off of [...windowOffsets, null]) {
        const deadline = off === null ? null : iso(NOW + DEADLINE_WINDOW_MS + off * SEC);
        const served = maxAge(edgeCachePolicy(fresh(path, age, deadline), NOW));
        for (let t = 0; t < served; t++) {
          const ttlThen = ttlSeconds(path, { now: NOW + t * SEC, nextDeadline: deadline });
          assert.ok(age + t < ttlThen,
            `${kind} age ${age} window ${off}s: edge serves at +${t}s a copy ${age + t}s old, TTL then ${ttlThen}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 10000, 'the walk really ran');
});

test('stale copies and errors are never edge-cached, deadline or not', () => {
  const deadline = iso(NOW + 2 * 3600 * SEC);
  assert.equal(edgeCachePolicy({ ...fresh('fixtures', 0, deadline), stale: true }, NOW), 'no-store');
  assert.equal(edgeCachePolicy({ ...fresh('fixtures', 0, deadline), status: 503 }, NOW), 'no-store');
  assert.equal(edgeCachePolicy({ ...fresh('entry/1', 0, deadline), status: 404 }, NOW), 'no-store');
});

// ------------------------------------------------------ through the handler ---

let hooksOk = true;
try { register('./tp-assist-blobs-hooks.mjs', import.meta.url); } catch { hooksOk = false; }
const opts = hooksOk ? {} : { skip: 'node:module register() unavailable' };

const STORE = 'fpl-planner';
function seedBlobs(entries = {}) {
  const map = new Map();
  let seq = 0;
  for (const [k, v] of Object.entries(entries)) map.set(k, { data: v, etag: 'etag-' + (++seq) });
  globalThis.__tpAssistBlobStub = { stores: { [STORE]: map }, seq };
}
const req = path => new Request(`https://shevato.com/.netlify/functions/fpl?path=${encodeURIComponent(path)}`, {
  headers: { Origin: 'https://shevato.com', 'x-nf-client-connection-ip': '203.0.113.7' },
});
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const ok = body => new Response(JSON.stringify(body), { status: 200 });
const edge = res => res.headers.get('netlify-cdn-cache-control');

test('handler: a blob HIT inside the window emits the collapsed edge window minus the age it reports', opts, async () => {
  const now = Date.now();
  seedBlobs({
    [DEADLINE_KEY]: { nextDeadline: iso(now + 2 * 3600 * SEC) },
    [cacheKey('fixtures')]: { fetchedAt: iso(now - 30 * SEC), body: [{ id: 1 }] },
  });
  const res = await withFetch(async () => { throw new Error('no upstream on a hit'); }, () => handler(req('fixtures')));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-fpl-cache'), 'hit');
  const age = Number(res.headers.get('x-fpl-age-seconds'));
  assert.ok(age >= 30 && age <= 32, `x-fpl-age-seconds is the copy's age when the function answered (${age})`);
  // The frozen header plus everything the edge can add on top stays inside
  // the collapsed TTL, which is what makes a CDN-served copy's reported age
  // (x-fpl-age-seconds + Age) honest at every moment the edge serves it.
  assert.equal(edge(res), `public, max-age=${DEADLINE_TTL_SECONDS - age}`);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'the browser cache is still kept out of it');
});

test('handler: a bootstrap MISS takes the deadline from the body it just fetched', opts, async () => {
  const now = Date.now();
  seedBlobs({}); // no stored deadline at all: the body is the only source
  const body = { events: [{ id: 5, deadline_time: iso(now + 90 * 60 * SEC) }] };
  const res = await withFetch(async () => ok(body), () => handler(req('bootstrap-static')));
  assert.equal(res.headers.get('x-fpl-cache'), 'miss');
  assert.equal(res.headers.get('x-fpl-age-seconds'), '0');
  assert.equal(edge(res), `public, max-age=${DEADLINE_TTL_SECONDS}`);
});

test('handler: any other MISS inside the window reads the stored deadline', opts, async () => {
  const now = Date.now();
  seedBlobs({ [DEADLINE_KEY]: { nextDeadline: iso(now + 2 * 3600 * SEC) } });
  const res = await withFetch(async () => ok({ current: [] }), () => handler(req('entry/4231987/history')));
  assert.equal(res.headers.get('x-fpl-cache'), 'miss');
  assert.equal(edge(res), `public, max-age=${Math.min(TTL.entry, DEADLINE_TTL_SECONDS)}`);
});

test('handler: far from a deadline the base TTL still reaches the edge', opts, async () => {
  const now = Date.now();
  seedBlobs({ [DEADLINE_KEY]: { nextDeadline: iso(now + 3 * 24 * 3600 * SEC) } });
  const res = await withFetch(async () => ok([{ id: 1 }]), () => handler(req('fixtures')));
  assert.equal(edge(res), `public, max-age=${TTL.fixtures}`);
});

test('handler: a stale copy served through an outage is never edge-cached', opts, async () => {
  const now = Date.now();
  seedBlobs({
    [DEADLINE_KEY]: { nextDeadline: iso(now + 2 * 3600 * SEC) },
    [cacheKey('fixtures')]: { fetchedAt: iso(now - 4000 * SEC), body: [{ id: 1 }] },
  });
  const res = await withFetch(async () => new Response('down', { status: 503 }), () => handler(req('fixtures')));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-fpl-stale'), 'true');
  assert.equal(edge(res), 'no-store');
});
