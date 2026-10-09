// What the FPL proxy does AFTER a deadline, what it refuses to cache, and the
// two endpoints whose TTL is not the ordinary one.
//
// THE BUG (2026-10-09 audit B4). The TTL collapse ended at the deadline, so the
// minutes in which the gameweek flips were the ones with the LONGEST cache
// life: a bootstrap fetched 90 s before the deadline was served at deadline +
// 30 s as a fresh hit with max-age=480 at the edge, still naming the locked
// gameweek as next, and the app's forced reload got that same copy back. The
// collapse is now held for POST_DEADLINE_WINDOW_MS after the most recent
// deadline on the blob TTL and the edge policy alike.
//
// Also pinned here: a 200 that is not the payload is never cached (it used to
// be served to everyone as fresh for a whole TTL), `event-status` is on the
// allowlist, and picks for a finished gameweek live for a day.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { edgeCachePolicy } from '../fpl.mjs';
import {
  serveFpl, ttlSeconds, cacheKey, canonicalPath, pathKind, hasExpectedShape, deadlineMetaFrom,
  TTL, DEADLINE_KEY, DEADLINE_TTL_SECONDS, DEADLINE_WINDOW_MS, POST_DEADLINE_WINDOW_MS,
  FINISHED_PICKS_TTL_SECONDS,
} from '../lib/fpl-cache.mjs';

const SEC = 1000;
const MIN = 60 * SEC;
const DEADLINE = Date.parse('2026-10-10T10:00:00Z');
const iso = ms => new Date(ms).toISOString();
const maxAge = policy => (policy === 'no-store' ? 0 : Number(/max-age=(\d+)/.exec(policy)[1]));

function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : null; },
    async setJSON(key, value) { map.set(key, structuredClone(value)); return { modified: true }; },
    async getWithMetadata(key) { return map.has(key) ? { data: structuredClone(map.get(key)), etag: 'e' } : null; },
  };
}
const ok = body => new Response(JSON.stringify(body), { status: 200 });
// A bootstrap as FPL serves it in the minutes before the GW6 deadline: GW5 is
// current, GW6 is next and its deadline has not passed yet.
const preDeadlineBootstrap = {
  elements: [], teams: [],
  events: [
    { id: 5, deadline_time: iso(DEADLINE - 7 * 24 * 3600 * SEC), is_current: true, is_next: false },
    { id: 6, deadline_time: iso(DEADLINE), is_current: false, is_next: true },
    { id: 7, deadline_time: iso(DEADLINE + 7 * 24 * 3600 * SEC), is_current: false, is_next: false },
  ],
};

// ------------------------------------------------ B4: after the deadline ---

test('B4 repro: a bootstrap fetched just before the deadline is NOT a fresh hit half a minute after it', async () => {
  // postdeadline.mjs from the audit, as a test. Before the fix the second call
  // was cache: hit, stale: false, and the edge was told max-age=480.
  const store = memoryStore();
  let calls = 0;
  const fetchUpstream = async () => { calls++; return ok(preDeadlineBootstrap); };
  await serveFpl({ path: 'bootstrap-static', store, fetchUpstream, now: DEADLINE - 90 * SEC });

  const t = DEADLINE + 30 * SEC;
  const after = await serveFpl({ path: 'bootstrap-static', store, fetchUpstream, now: t });
  assert.equal(calls, 2, 'a 120 s old copy is past the collapsed TTL, so it is refreshed');
  assert.equal(after.cache, 'miss');
  const policy = edgeCachePolicy({ ...after, path: 'bootstrap-static' }, t);
  assert.ok(maxAge(policy) <= DEADLINE_TTL_SECONDS, `edge held to the collapsed TTL, got ${policy}`);
});

test('B4: every TTL stays collapsed for the post-deadline window, then returns to base', () => {
  // The stored meta as it reads right after the deadline: written before it,
  // so nextDeadline is the one that just passed.
  const stale = { nextDeadline: iso(DEADLINE), lastDeadline: iso(DEADLINE - 7 * 24 * 3600 * SEC) };
  // And as it reads once a post-deadline bootstrap has rewritten it.
  const rewritten = { nextDeadline: iso(DEADLINE + 7 * 24 * 3600 * SEC), lastDeadline: iso(DEADLINE) };
  for (const meta of [stale, rewritten]) {
    for (const path of ['bootstrap-static', 'fixtures', 'entry/1', 'entry/1/history', 'element-summary/3', 'event-status']) {
      const base = TTL[pathKind(path)];
      const at = offset => ttlSeconds(path, { now: DEADLINE + offset, ...meta });
      assert.equal(at(0), Math.min(base, DEADLINE_TTL_SECONDS), `${path} at the deadline`);
      assert.equal(at(30 * SEC), Math.min(base, DEADLINE_TTL_SECONDS), `${path} at +30 s`);
      assert.equal(at(POST_DEADLINE_WINDOW_MS - SEC), Math.min(base, DEADLINE_TTL_SECONDS), `${path} at the window's last second`);
      assert.equal(at(POST_DEADLINE_WINDOW_MS), base, `${path} once the window has closed`);
    }
  }
  assert.equal(POST_DEADLINE_WINDOW_MS, 60 * MIN);
});

test('B4: a deadline meta from before this change (nextDeadline only) still collapses after the deadline', () => {
  // Blobs written by the previous deploy carry no lastDeadline. The passed
  // nextDeadline is enough.
  assert.equal(ttlSeconds('fixtures', { now: DEADLINE + 5 * MIN, nextDeadline: iso(DEADLINE) }), DEADLINE_TTL_SECONDS);
});

test('B4: the bootstrap fetch records the passed deadline and the current gameweek with the next one', async () => {
  const store = memoryStore();
  const fetchUpstream = async () => ok(preDeadlineBootstrap);
  await serveFpl({ path: 'bootstrap-static', store, fetchUpstream, now: DEADLINE - 90 * SEC });
  assert.deepEqual(store.map.get(DEADLINE_KEY), {
    nextDeadline: iso(DEADLINE),
    lastDeadline: iso(DEADLINE - 7 * 24 * 3600 * SEC),
    currentEvent: 5,
  });
  assert.deepEqual(deadlineMetaFrom(preDeadlineBootstrap, DEADLINE + SEC), {
    nextDeadline: iso(DEADLINE + 7 * 24 * 3600 * SEC),
    lastDeadline: iso(DEADLINE),
    currentEvent: 5,
  });
});

test('B4: an entry cached before the deadline is refreshed after it, via the stored meta', async () => {
  const store = memoryStore({
    [DEADLINE_KEY]: { nextDeadline: iso(DEADLINE), lastDeadline: null, currentEvent: 5 },
    // Four minutes old: fresh under the 5 min base TTL, expired under 120 s.
    [cacheKey('entry/7/history')]: { fetchedAt: iso(DEADLINE - 3 * MIN), body: { current: [{ event: 5 }] } },
  });
  let calls = 0;
  const res = await serveFpl({
    path: 'entry/7/history', store, now: DEADLINE + MIN,
    fetchUpstream: async () => { calls++; return ok({ current: [{ event: 5 }, { event: 6 }] }); },
  });
  assert.equal(calls, 1);
  assert.equal(res.cache, 'miss');
  assert.equal(res.lastDeadline, null);
  assert.equal(res.nextDeadline, iso(DEADLINE), 'the meta it was judged against rides on the result');
});

test('B4: the edge window collapses after a deadline exactly as the function does', () => {
  const fresh = (path, ageSeconds, meta) => ({ status: 200, stale: false, path, ageSeconds, ...meta });
  const meta = { nextDeadline: iso(DEADLINE + 7 * 24 * 3600 * SEC), lastDeadline: iso(DEADLINE) };
  assert.equal(edgeCachePolicy(fresh('bootstrap-static', 0, meta), DEADLINE + 30 * SEC), `public, max-age=${DEADLINE_TTL_SECONDS}`);
  assert.equal(edgeCachePolicy(fresh('fixtures', 20, meta), DEADLINE + 10 * MIN), `public, max-age=${DEADLINE_TTL_SECONDS - 20}`);
  // Past the window, base again.
  assert.equal(edgeCachePolicy(fresh('fixtures', 0, meta), DEADLINE + POST_DEADLINE_WINDOW_MS), `public, max-age=${TTL.fixtures}`);
  // The stale-meta shape (nextDeadline is the one that passed) too.
  assert.equal(edgeCachePolicy(fresh('bootstrap-static', 0, { nextDeadline: iso(DEADLINE) }), DEADLINE + 30 * SEC),
    `public, max-age=${DEADLINE_TTL_SECONDS}`);
});

test('B4 THE INVARIANT, after a deadline: no second of the edge window serves data the function would call expired', () => {
  const paths = ['bootstrap-static', 'fixtures', 'entry/4231987/history', 'element-summary/328', 'event/6/live', 'event-status'];
  const ages = [0, 1, 30, 59, 60, 100, 119, 200, 299, 599, 899, 1799];
  // Seconds since the most recent deadline, both sides of the window's end.
  const sinceDeadline = [-30, 0, 1, 30, 600, 3480, 3540, 3599, 3600, 3601, 7200];
  let checked = 0;
  for (const path of paths) {
    for (const age of ages) {
      for (const since of sinceDeadline) {
        const now = DEADLINE + since * SEC;
        // The rewritten meta only exists once the deadline has passed:
        // deadlineMetaFrom never records a lastDeadline in the future.
        const metas = [{ nextDeadline: iso(DEADLINE) }];
        if (since >= 0) metas.push({ nextDeadline: iso(DEADLINE + 7 * 24 * 3600 * SEC), lastDeadline: iso(DEADLINE) });
        for (const meta of metas) {
          if (age >= ttlSeconds(path, { now, ...meta })) continue;
          const served = maxAge(edgeCachePolicy({ status: 200, stale: false, path, ageSeconds: age, ...meta }, now));
          for (let t = 0; t < served; t++) {
            const ttlThen = ttlSeconds(path, { now: now + t * SEC, ...meta });
            assert.ok(age + t < ttlThen, `${path} age ${age} at deadline+${since}s: edge serves a ${age + t}s copy, TTL then ${ttlThen}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 10000, 'the walk really ran');
});

// --------------------------------------------- shape before caching ---

const VALID = {
  'bootstrap-static': { elements: [], events: [], teams: [] },
  fixtures: [],
  'entry/7': { id: 7, name: 'x' },
  'entry/7/history': { current: [] },
  'entry/7/transfers': [],
  'entry/7/event/6/picks': { picks: [] },
  'element-summary/3': { history: [] },
  'event/6/live': { elements: [] },
  'event-status': { status: [], leagues: 'Updated' },
};
const INVALID = {
  'bootstrap-static': [{ elements: [] }, { elements: [], events: [] }, { events: [], teams: [] }, 'The game is being updated.', null, {}],
  fixtures: [{}, 'The game is being updated.', null],
  'entry/7': [{}, [], { id: null }, 'x', null],
  'entry/7/history': [{}, { current: {} }, [], null],
  'entry/7/transfers': [{}, 'x', null],
  'entry/7/event/6/picks': [{}, { picks: {} }, [], null],
  'element-summary/3': [{}, { history: null }, [], null],
  'event/6/live': [{}, { elements: {} }, [], null],
  'event-status': [{}, [], 'x', null],
};

test('shape: every allowlisted path accepts its real shape and rejects the failures FPL answers with a 200', () => {
  for (const [path, body] of Object.entries(VALID)) {
    assert.equal(hasExpectedShape(path, body), true, `${path} valid`);
    for (const bad of INVALID[path]) assert.equal(hasExpectedShape(path, bad), false, `${path} rejects ${JSON.stringify(bad)}`);
  }
});

test('shape: a malformed 200 with nothing cached is a labelled 502 and is never cached', async () => {
  for (const [path, bads] of Object.entries(INVALID)) {
    const store = memoryStore();
    const res = await serveFpl({ path, store, now: DEADLINE, fetchUpstream: async () => ok(bads[0]) });
    assert.equal(res.status, 502, path);
    assert.deepEqual(res.body, { error: 'upstream_malformed' });
    assert.equal(res.stale, false);
    assert.equal(store.map.has(cacheKey(path)), false, `${path}: nothing written`);
    assert.equal(store.map.has(DEADLINE_KEY), false, `${path}: no deadline meta from a bad body`);
  }
});

test('shape: a malformed 200 keeps the good cached copy and serves it marked stale', async () => {
  const good = { elements: [{ id: 1 }], events: [], teams: [] };
  const store = memoryStore({ [cacheKey('bootstrap-static')]: { fetchedAt: iso(DEADLINE - 3 * 3600 * SEC), body: good } });
  const res = await serveFpl({
    path: 'bootstrap-static', store, now: DEADLINE,
    fetchUpstream: async () => ok('The game is being updated.'),
  });
  assert.equal(res.status, 200);
  assert.equal(res.stale, true);
  assert.deepEqual(res.body, good);
  assert.deepEqual(store.map.get(cacheKey('bootstrap-static')).body, good, 'the good copy was not overwritten');
});

let hooksOk = true;
try { register('./tp-assist-blobs-hooks.mjs', import.meta.url); } catch { hooksOk = false; }
const opts = hooksOk ? {} : { skip: 'node:module register() unavailable' };
const req = path => new Request(`https://shevato.com/.netlify/functions/fpl?path=${encodeURIComponent(path)}`, {
  headers: { Origin: 'https://shevato.com', 'x-nf-client-connection-ip': '203.0.113.7' },
});
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('handler: a malformed upstream 200 reaches the client as a 502 that no cache holds', opts, async () => {
  globalThis.__tpAssistBlobStub = { stores: { 'fpl-planner': new Map() }, seq: 0 };
  const res = await withFetch(async () => ok({ detail: 'The game is being updated.' }), () => handler(req('fixtures')));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'upstream_malformed' });
  assert.equal(res.headers.get('netlify-cdn-cache-control'), 'no-store');
  assert.equal(res.headers.get('x-fpl-cache'), 'miss', 'still ours, so the client does not read it as a missing function');
});

// ------------------------------------------------------ event-status ---

test('event-status is allowlisted with a 60 s TTL that collapses like every other', () => {
  assert.equal(canonicalPath('event-status'), 'event-status');
  assert.equal(canonicalPath('/event-status/'), 'event-status');
  for (const bad of ['event-status/1', 'event-statusx', 'event-status?x=1']) assert.equal(canonicalPath(bad), null, bad);
  assert.equal(TTL['event-status'], 60);
  const far = Date.parse('2026-10-01T10:00:00Z');
  assert.equal(ttlSeconds('event-status', { now: far, nextDeadline: iso(DEADLINE) }), 60);
  assert.equal(ttlSeconds('event-status', { now: DEADLINE - MIN, nextDeadline: iso(DEADLINE) }), Math.min(60, DEADLINE_TTL_SECONDS));
});

test('event-status is cached through the ordinary pipeline', async () => {
  const store = memoryStore();
  let calls = 0;
  const fetchUpstream = async (url) => { calls++; assert.match(url, /\/api\/event-status\/$/); return ok(VALID['event-status']); };
  const far = Date.parse('2026-10-01T10:00:00Z');
  await serveFpl({ path: 'event-status', store, fetchUpstream, now: far });
  const hit = await serveFpl({ path: 'event-status', store, fetchUpstream, now: far + 59 * SEC });
  assert.equal(hit.cache, 'hit');
  const miss = await serveFpl({ path: 'event-status', store, fetchUpstream, now: far + 61 * SEC });
  assert.equal(miss.cache, 'miss');
  assert.equal(calls, 2);
});

// ------------------------------------------------- finished picks ---

test('picks for a gameweek before the current one live for a day; the current one does not', () => {
  const meta = { nextDeadline: iso(DEADLINE), lastDeadline: null, currentEvent: 5 };
  const far = DEADLINE - 3 * 24 * 3600 * SEC;
  assert.equal(FINISHED_PICKS_TTL_SECONDS, 24 * 3600);
  assert.equal(ttlSeconds('entry/7/event/4/picks', { now: far, ...meta }), FINISHED_PICKS_TTL_SECONDS);
  assert.equal(ttlSeconds('entry/7/event/1/picks', { now: far, ...meta }), FINISHED_PICKS_TTL_SECONDS);
  assert.equal(ttlSeconds('entry/7/event/5/picks', { now: far, ...meta }), TTL.entry, 'the current gameweek is still being scored');
  assert.equal(ttlSeconds('entry/7/event/6/picks', { now: far, ...meta }), TTL.entry);
  // Nothing about a finished gameweek moves at a deadline, so neither window
  // shortens it; the current gameweek's picks collapse as before.
  assert.equal(ttlSeconds('entry/7/event/4/picks', { now: DEADLINE - MIN, ...meta }), FINISHED_PICKS_TTL_SECONDS);
  assert.equal(ttlSeconds('entry/7/event/5/picks', { now: DEADLINE - MIN, ...meta }), DEADLINE_TTL_SECONDS);
  // With no current gameweek known (pre-season, or an old meta) nothing is long-lived.
  assert.equal(ttlSeconds('entry/7/event/4/picks', { now: far, nextDeadline: iso(DEADLINE) }), TTL.entry);
  // And only picks: the history endpoint is not a picks path.
  assert.equal(ttlSeconds('entry/7/history', { now: far, ...meta }), TTL.entry);
});

test('finished picks are served from the blob for the whole day and reach the edge with a day-long window', async () => {
  const store = memoryStore({ [DEADLINE_KEY]: { nextDeadline: iso(DEADLINE), lastDeadline: null, currentEvent: 5 } });
  let calls = 0;
  const fetchUpstream = async () => { calls++; return ok({ picks: [{ element: 1 }] }); };
  const t0 = DEADLINE - 2 * 24 * 3600 * SEC;
  const first = await serveFpl({ path: 'entry/7/event/3/picks', store, fetchUpstream, now: t0 });
  const later = await serveFpl({ path: 'entry/7/event/3/picks', store, fetchUpstream, now: t0 + 23 * 3600 * SEC });
  assert.equal(calls, 1);
  assert.equal(later.cache, 'hit');
  assert.equal(edgeCachePolicy({ ...first, path: 'entry/7/event/3/picks' }, t0), `public, max-age=${FINISHED_PICKS_TTL_SECONDS}`);
  // Even when the pre-deadline window opens inside that day: the TTL does not
  // shrink there for a finished gameweek, so there is nothing to clamp to.
  const nearWindow = DEADLINE - DEADLINE_WINDOW_MS - 3600 * SEC;
  assert.equal(edgeCachePolicy({ ...first, ageSeconds: 0, path: 'entry/7/event/3/picks' }, nearWindow),
    `public, max-age=${FINISHED_PICKS_TTL_SECONDS}`);
});
