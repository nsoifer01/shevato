// The browser cache around a deadline, and the copies it must not keep.
//
// B4 (2026-10-09 audit). The client collapsed its TTLs only BEFORE a deadline,
// reading the next deadline out of the bootstrap it holds and skipping any that
// had passed. So in the minutes after the deadline, when the gameweek flips,
// it went back to ten-minute bootstraps and thirty-minute fixtures. It now
// holds the collapse for POST_DEADLINE_WINDOW_SECONDS after the most recent
// passed deadline, read from the same events.
//
// B5. A copy the proxy marked stale was kept for its endpoint's full TTL, so
// the stale banner and the old numbers stayed on screen for ten minutes after
// the proxy had fresh data (audit repro clientstale.mjs). It now lives
// STALE_TTL_SECONDS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFplApi, labelFor, deadlineRetryDelayMs,
  CLIENT_TTL, DEADLINE_TTL_SECONDS, POST_DEADLINE_WINDOW_SECONDS, STALE_TTL_SECONDS,
  FINISHED_PICKS_TTL_SECONDS, DEADLINE_RETRY_MS,
} from '../js/data/api.js';

const DEADLINE = Date.parse('2026-10-10T10:00:00Z');
const SEC = 1000;

function proxyResponse(body, { stale = false, ageSeconds = 0 } = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'x-fpl-cache': 'hit',
      'x-fpl-fetched-at': new Date(DEADLINE).toISOString(),
      'x-fpl-stale': String(stale),
      'x-fpl-age-seconds': String(ageSeconds),
    },
  });
}

function recorder(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  fn.calls = calls;
  return fn;
}
const countOf = (fetchImpl, path) => fetchImpl.calls.filter(u => u.endsWith(`path=${encodeURIComponent(path)}`)).length;

// GW6's deadline is DEADLINE. Before it GW5 is current; the payload served in
// the minutes after it still says so, which is the case that matters.
const bootstrap = {
  events: [
    { id: 5, deadline_time: new Date(DEADLINE - 7 * 24 * 3600 * SEC).toISOString(), is_current: true, is_next: false },
    { id: 6, deadline_time: new Date(DEADLINE).toISOString(), is_current: false, is_next: true },
    { id: 7, deadline_time: new Date(DEADLINE + 7 * 24 * 3600 * SEC).toISOString(), is_current: false, is_next: false },
  ],
};

function world(startAt) {
  let clock = startAt;
  const fetchImpl = recorder((url) => (url.includes('bootstrap-static') ? proxyResponse(bootstrap)
    : url.includes('fixtures') ? proxyResponse([{ id: 1 }])
      : url.includes('picks') ? proxyResponse({ picks: [] })
        : proxyResponse({})));
  const api = createFplApi({ fetchImpl, storage: null, now: () => clock });
  return { api, fetchImpl, advance: (ms) => { clock += ms; }, at: (ms) => { clock = ms; } };
}

// ---------------------------------------------------------------- B4 ---

test('B4: half a minute after a deadline a two-and-a-half minute old bootstrap is refetched, not held for ten', async () => {
  const w = world(DEADLINE - 2 * 60 * SEC);
  await w.api.getBootstrap();
  w.at(DEADLINE + 30 * SEC);
  await w.api.getBootstrap();
  assert.equal(countOf(w.fetchImpl, 'bootstrap-static'), 2, 'past the deadline the collapsed TTL still applies');
});

test('B4: fixtures are held to the collapsed TTL for the whole post-deadline hour, then the base TTL returns', async () => {
  const w = world(DEADLINE + 5 * 60 * SEC);
  await w.api.getBootstrap();
  await w.api.getFixtures();
  w.advance((DEADLINE_TTL_SECONDS + 1) * SEC);
  await w.api.getFixtures();
  assert.equal(countOf(w.fetchImpl, 'fixtures'), 2, 'a two-minute fixtures copy is expired five minutes after a deadline');

  // Well past the window: the base 30-minute TTL holds again.
  w.at(DEADLINE + POST_DEADLINE_WINDOW_SECONDS * SEC + 60 * SEC);
  await w.api.getBootstrap({ force: true });
  await w.api.getFixtures({ force: true });
  w.advance(5 * 60 * SEC);
  await w.api.getFixtures();
  assert.equal(countOf(w.fetchImpl, 'fixtures'), 3, 'five minutes is inside the base TTL once the hour is over');
});

test('B4: the post-deadline window is an hour, the same as the proxy', () => {
  assert.equal(POST_DEADLINE_WINDOW_SECONDS, 3600);
});

test('B4: a forced read always goes to the network, whatever the TTL', async () => {
  const w = world(DEADLINE + 10 * SEC);
  await w.api.getBootstrap();
  await w.api.getBootstrap({ force: true });
  assert.equal(countOf(w.fetchImpl, 'bootstrap-static'), 2);
});

test('B4: the deadline retry is scheduled only inside the post-deadline window', () => {
  assert.equal(deadlineRetryDelayMs(DEADLINE, DEADLINE + SEC), DEADLINE_RETRY_MS);
  assert.equal(deadlineRetryDelayMs(DEADLINE, DEADLINE + 30 * 60 * SEC), DEADLINE_RETRY_MS);
  // The retry must land inside the window, or it is a re-read nobody asked for.
  assert.equal(deadlineRetryDelayMs(DEADLINE, DEADLINE + POST_DEADLINE_WINDOW_SECONDS * SEC - DEADLINE_RETRY_MS + SEC), null);
  assert.equal(deadlineRetryDelayMs(DEADLINE, DEADLINE + 2 * 3600 * SEC), null);
  assert.equal(deadlineRetryDelayMs(DEADLINE, DEADLINE - SEC), null, 'not before the deadline');
  assert.equal(deadlineRetryDelayMs(NaN, DEADLINE), null);
  // Bounded: an hour of retries at this spacing is under fifty requests.
  assert.ok(DEADLINE_RETRY_MS >= 60 * SEC && DEADLINE_RETRY_MS <= 90 * SEC);
  assert.ok(POST_DEADLINE_WINDOW_SECONDS * SEC / DEADLINE_RETRY_MS < 50);
});

// ---------------------------------------------------------------- B5 ---

test('B5 repro: a stale proxy copy is re-asked after STALE_TTL_SECONDS, not after the full TTL', async () => {
  // clientstale.mjs from the audit: first answer stale, every later one fresh.
  // Before the fix the second read at +300 s was still served from cache.
  let clock = Date.parse('2026-10-05T12:00:00Z');
  let n = 0;
  const fetchImpl = recorder(() => { n++; return proxyResponse({ events: [] }, { stale: n === 1, ageSeconds: 650 }); });
  const api = createFplApi({ fetchImpl, storage: null, now: () => clock });
  const first = await api.getBootstrap();
  assert.equal(first.stale, true);

  clock += (STALE_TTL_SECONDS - 1) * SEC;
  await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 1, 'inside the stale TTL the copy is still served (a burst is not a stampede)');

  clock += 2 * SEC;
  const second = await api.getBootstrap();
  assert.equal(fetchImpl.calls.length, 2, 'past it the proxy is asked again');
  assert.equal(second.stale, false);
  assert.ok(CLIENT_TTL.bootstrap > STALE_TTL_SECONDS * 10);
});

test('B5: a stale copy restored from localStorage gets the short life too', async () => {
  const map = new Map();
  const storage = {
    get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k),
  };
  let clock = Date.parse('2026-10-05T12:00:00Z');
  map.set('fpl-planner:cache:fixtures', JSON.stringify({
    fetchedAt: new Date(clock).toISOString(), stale: true, data: [{ old: true }], receivedAt: clock - 30 * SEC, serverAgeSeconds: 900,
  }));
  const fetchImpl = recorder(() => proxyResponse([{ fresh: true }]));
  const api = createFplApi({ fetchImpl, storage, now: () => clock });
  const res = await api.getFixtures();
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(res.data, [{ fresh: true }]);
});

// ------------------------------------------------------ finished picks ---

test('picks for a finished gameweek are kept for a day once the bootstrap says which gameweek is current', async () => {
  const w = world(DEADLINE - 3 * 24 * 3600 * SEC);
  await w.api.getBootstrap();
  await w.api.getEntryPicks(7, 3);
  await w.api.getEntryPicks(7, 5);
  w.advance(2 * 3600 * SEC);
  await w.api.getBootstrap();
  await w.api.getEntryPicks(7, 3);
  await w.api.getEntryPicks(7, 5);
  assert.equal(countOf(w.fetchImpl, 'entry/7/event/3/picks'), 1, 'GW3 is history while GW5 is current');
  assert.equal(countOf(w.fetchImpl, 'entry/7/event/5/picks'), 2, 'the current gameweek keeps the ordinary entry TTL');
  w.advance(FINISHED_PICKS_TTL_SECONDS * SEC);
  await w.api.getBootstrap();
  await w.api.getEntryPicks(7, 3);
  assert.equal(countOf(w.fetchImpl, 'entry/7/event/3/picks'), 2, 'and a day later it is re-asked');
});

test('without a bootstrap in hand no picks are treated as finished', async () => {
  const w = world(DEADLINE - 3 * 24 * 3600 * SEC);
  await w.api.getEntryPicks(7, 3);
  w.advance((CLIENT_TTL.entry + 1) * SEC);
  await w.api.getEntryPicks(7, 3);
  assert.equal(countOf(w.fetchImpl, 'entry/7/event/3/picks'), 2);
});

// -------------------------------------------------------- event-status ---

test('event-status is a fetchable endpoint with its own label and a 60 s TTL', async () => {
  let clock = Date.parse('2026-10-01T10:00:00Z');
  const fetchImpl = recorder(() => proxyResponse({ status: [{ event: 6, points: 'r', bonus_added: false }], leagues: 'Updating' }));
  const api = createFplApi({ fetchImpl, storage: null, now: () => clock });
  const res = await api.getEventStatus();
  assert.equal(fetchImpl.calls[0], '/.netlify/functions/fpl?path=event-status');
  assert.equal(res.data.leagues, 'Updating');
  clock += 59 * SEC;
  await api.getEventStatus();
  clock += 2 * SEC;
  await api.getEventStatus();
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(CLIENT_TTL['event-status'], 60);
  assert.equal(labelFor('event-status'), 'Gameweek processing status');
});

// ------------------------------------------- ageSeconds for B14 ---

test('every way a bootstrap read can resolve carries a finite, skew-free ageSeconds', async () => {
  // app.js hands bootstrap.ageSeconds to buildGameState so the plan's data age
  // never subtracts a server timestamp from the device clock (audit B14). A
  // path that left it undefined would silently fall back to that subtraction.
  let clock = Date.parse('2026-10-05T12:00:00Z');
  let fail = false;
  const fetchImpl = recorder(() => {
    if (fail) throw new TypeError('network down');
    return proxyResponse({ events: [] }, { ageSeconds: 40 });
  });
  const api = createFplApi({ fetchImpl, storage: null, now: () => clock });
  const miss = await api.getBootstrap();
  assert.equal(miss.ageSeconds, 40, 'a network answer: the proxy\'s own age');
  clock += 30 * SEC;
  const hit = await api.getBootstrap();
  assert.equal(hit.ageSeconds, 70, 'a cache hit: that age plus the time held here');
  fail = true;
  const stale = await api.getBootstrap({ force: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.ageSeconds, 70, 'the stale fallback too');
});
