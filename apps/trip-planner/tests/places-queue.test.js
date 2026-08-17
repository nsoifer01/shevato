'use strict';

// Regression cover for the Places lookup queue (trip-logic.js
// createPlacesQueue), which owns every billed rating request the app makes.
//
// Each of these pins a failure that cost the owner real money in production on
// 2026-08-17, or a rule that keeps the fix honest. The queue is pure - `send`,
// `now`, `schedule` and `random` are all injected - so every branch runs here
// with no browser, no network and no billed call.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

// A controllable clock + scheduler. `schedule` collects timers instead of
// running them, so a test decides exactly when a pause expires; nothing here
// depends on wall-clock time.
function harness(overrides = {}) {
  let clock = 1780000000000;
  const timers = [];
  const sent = [];
  let reply = queries => ({ ok: true, results: queries.map(okResult) });

  const queue = L.createPlacesQueue({
    now: () => clock,
    schedule: (fn, ms) => timers.push({ fn, at: clock + ms }),
    random: () => 0.5,
    send: async (queries) => {
      sent.push(queries.slice());
      return reply(queries, sent.length);
    },
    ...overrides,
  });

  return {
    queue,
    sent,
    posts: () => sent.length,
    allQueries: () => sent.flat(),
    setReply(fn) { reply = fn; },
    advance(ms) {
      clock += ms;
      const due = timers.filter(t => t.at <= clock);
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
    },
    now: () => clock,
    pendingTimers: () => timers.length,
  };
}

const okResult = (query) => ({
  query, status: 'ok', name: query, rating: 4.5, userRatingCount: 1481,
  mapsUri: 'https://maps.google.com/?cid=1',
});

// A drained promise chain: the queue sends inside promise callbacks, so tests
// have to let the microtask queue run before reading what landed.
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

const venues = n => Array.from({ length: n }, (_, i) => `Venue Number ${i + 1} Tokyo`);

// ---------- coalescing: the measured duplicate-batch bug ----------

test('a key is reserved when it is PLANNED, so a second render cannot re-request it', async () => {
  // THE 2026-08-17 BUG. The old loop marked a batch in flight only when its
  // turn came, so batches 2..N were invisible to a planner running in between:
  // a Timeline -> Days switch mid-lookup measured 7 POSTs / 70 lookups for 41
  // venues, 29 of them duplicates. Every query must appear on the wire once.
  const h = harness();
  const list = venues(41);
  h.queue.request(list);          // first render
  h.queue.request(list);          // a re-render landing immediately after
  h.queue.request(list);          // and another
  await settle(40);

  const asked = h.allQueries();
  assert.equal(asked.length, 41, 'exactly one lookup per venue');
  assert.equal(new Set(asked.map(q => q.toLowerCase())).size, 41, 'no duplicates on the wire');
});

test('identical simultaneous requests for one venue coalesce to a single lookup', async () => {
  const h = harness();
  h.queue.request(['Ichiran Shibuya Tokyo']);
  h.queue.request(['ichiran   SHIBUYA tokyo']);   // same venue, drifting spelling
  h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  assert.equal(h.allQueries().length, 1);
});

test('different venues are never collapsed into one another', async () => {
  const h = harness();
  h.queue.request(['Nabezo Shinjuku', 'Nabezo Shibuya', 'Narisawa Tokyo']);
  await settle(20);
  assert.deepEqual(h.allQueries().sort(), ['Nabezo Shibuya', 'Nabezo Shinjuku', 'Narisawa Tokyo']);
});

test('a resolved venue is never asked for again, however many times it re-renders', async () => {
  const h = harness();
  h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  assert.equal(h.posts(), 1);

  for (let i = 0; i < 20; i++) h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  assert.equal(h.posts(), 1, 'the session cache answers every repaint for free');
  assert.equal(h.queue.get('ichiran shibuya tokyo').rating, 4.5);
});

// ---------- batching and concurrency ----------

test('50 venues go out as bounded batches at bounded concurrency, not a burst', async () => {
  const h = harness();
  h.queue.request(venues(50));
  await settle(60);

  assert.equal(h.allQueries().length, 50);
  for (const batch of h.sent) {
    assert.ok(batch.length <= L.PLACES_BATCH_MAX, 'no batch exceeds the server cap of 12');
  }
  assert.equal(h.posts(), Math.ceil(50 / L.PLACES_BATCH_MAX));
});

test('concurrency never exceeds the configured ceiling', async () => {
  let inFlight = 0, peak = 0;
  const h = harness({
    send: async (queries) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, results: queries.map(okResult) };
    },
  });
  h.queue.request(venues(96));
  await settle(200);
  assert.ok(peak <= L.PLACES_CONCURRENCY, `peak concurrency ${peak} is within ${L.PLACES_CONCURRENCY}`);
  assert.ok(peak > 0);
});

// ---------- priority ----------

test('an urgent comparison is served before ambient itinerary rows', async () => {
  // A traveller reading a candidate set must not wait behind a screen of rows
  // that merely scrolled into view: a row without a rating is a plain link,
  // but a half-resolved candidate set makes its winner badges wrong.
  // A batch already on the wire cannot be un-sent, so the claim is about the
  // queue that is still WAITING: 24 rows means one batch leaves at once and
  // twelve rows queue behind it, and the urgent venue must overtake those.
  const h = harness({ concurrency: 1 });
  h.queue.request(venues(24).map(v => 'ROW ' + v), { priority: 'normal' });
  await settle(4);
  h.queue.request(['Urgent Candidate Tokyo'], { priority: 'urgent' });
  await settle(60);
  assert.equal(h.sent[1][0], 'Urgent Candidate Tokyo',
    'the urgent venue led the next batch instead of waiting for the rows: ' + JSON.stringify(h.sent[1].slice(0, 3)));
});

test('a venue an itinerary row already queued is promoted, not requested twice', async () => {
  const h = harness({
    send: async () => new Promise(() => {}),   // never resolves: keep the queue busy
  });
  h.queue.request(venues(40), { priority: 'normal' });
  const moved = h.queue.promote(['Venue Number 39 Tokyo']);
  assert.equal(moved, 1, 'the queued entry was promoted');
  const again = h.queue.promote(['Venue Number 39 Tokyo']);
  assert.equal(again, 0, 'promoting twice does not duplicate it');
  // and asking for it urgently now adds nothing new
  assert.equal(h.queue.request(['Venue Number 39 Tokyo'], { priority: 'urgent' }), 0);
});

// ---------- 429 handling ----------

test('a 429 parks the batch and puts it back, rather than losing the rest of the trip', async () => {
  // The old client abandoned every remaining batch on the first 429 AND
  // switched the feature off for a flat hour, so a partial set of ratings
  // looked permanent for the session.
  let calls = 0;
  const h = harness({
    send: async (queries) => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, scope: 'client_hour' };
      return { ok: true, results: queries.map(okResult) };
    },
  });
  h.queue.request(venues(5));
  await settle(20);
  assert.equal(calls, 1, 'the queue stops asking while it is parked');
  assert.equal(h.queue.status().paused, true);

  // The hour bucket rolls over; the SAME venues are served, not dropped.
  h.advance(L.placesRetryDelay('client_hour', h.now()) + 1);
  await settle(30);
  assert.equal(calls, 2);
  assert.equal(h.queue.status().cached, 5, 'every venue the 429 interrupted was still served');
});

test('a quota 429 does not become a retry loop', async () => {
  let calls = 0;
  const h = harness({ send: async () => { calls += 1; return { ok: false, status: 429, scope: 'client_day' }; } });
  h.queue.request(venues(3));
  await settle(20);

  // Push the clock forward well past several short backoffs. Nothing should
  // fire until the DAY bucket rolls over, and even then the retry is bounded.
  for (let i = 0; i < 20; i++) { h.advance(60000); await settle(10); }
  assert.equal(calls, 1, 'a day-scoped rejection is not re-asked minute by minute');
});

test('retries are bounded: a venue that keeps failing stops being asked', async () => {
  let calls = 0;
  const h = harness({ send: async () => { calls += 1; return { ok: false, status: 429, scope: 'contention' }; } });
  h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  for (let i = 0; i < 12; i++) { h.advance(60000); await settle(10); }
  assert.ok(calls <= L.PLACES_MAX_ATTEMPTS, `at most ${L.PLACES_MAX_ATTEMPTS} attempts, saw ${calls}`);
  assert.ok(calls >= 2, 'a transient rejection IS retried at least once');
});

test('the retry delay matches the bucket that actually refills', () => {
  // 10:59:00 UTC. The old client waited a flat hour from here, wasting 59
  // minutes of the 11:00 bucket.
  const t = Date.UTC(2026, 7, 17, 10, 59, 0);
  assert.equal(L.placesRetryDelay('client_hour', t), 60000, 'waits for the next hour bucket, not a full hour');
  assert.equal(L.placesRetryDelay('client_day', t), 86400000 - (t % 86400000));
  assert.equal(L.placesRetryDelay('global_day', t), L.placesRetryDelay('client_day', t));
  const month = L.placesRetryDelay('global_month', t);
  assert.equal(new Date(t + month).toISOString(), '2026-09-01T00:00:00.000Z');
  // Contention is the one genuinely transient scope: seconds, with jitter.
  const c = L.placesRetryDelay('contention', t, 1, () => 0.5);
  assert.ok(c >= 500 && c <= 1000, `contention backs off in seconds, got ${c}`);
  assert.ok(L.placesRetryDelay('contention', t, 3, () => 1) > L.placesRetryDelay('contention', t, 1, () => 1),
    'later attempts back off further');
});

test('a Retry-After from the server wins over the local guess', async () => {
  const h = harness({ send: async () => ({ ok: false, status: 429, scope: 'client_hour', retryAfterMs: 5000 }) });
  h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  assert.equal(h.queue.status().pausedUntil, h.now() + 5000);
});

// ---------- transient failures ----------

test('a partial response paints what it got and does not lose what it did not', async () => {
  const h = harness({
    send: async (queries) => ({
      ok: true,
      results: queries.map((q, i) => (i < 2 ? okResult(q) : { query: q, status: 'unavailable', reason: 'quota' })),
    }),
  });
  h.queue.request(venues(5));
  await settle(20);
  assert.equal(h.queue.status().cached, 2, 'the venues that resolved are usable');
  assert.equal(h.queue.status().deferred, 3, 'the rest are parked, not cached and not lost');
});

test('an unavailable venue is not re-asked by the very next repaint, but is not permanent', async () => {
  let calls = 0;
  const h = harness({
    send: async (queries) => {
      calls += 1;
      return { ok: true, results: queries.map(q => ({ query: q, status: 'unavailable', reason: 'quota' })) };
    },
  });
  h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  assert.equal(calls, 1);

  for (let i = 0; i < 30; i++) h.queue.request(['Ichiran Shibuya Tokyo']);   // 30 repaints
  await settle(20);
  assert.equal(calls, 1, 'a repaint storm cannot re-bill a venue that just failed');

  h.advance(L.PLACES_DEFER_MS + 1);
  h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  assert.equal(calls, 2, 'once the defer window passes a legitimate attempt is allowed again');
});

test('a network failure is transient, and the venues survive it', async () => {
  let calls = 0;
  const h = harness({
    send: async (queries) => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return { ok: true, results: queries.map(okResult) };
    },
  });
  h.queue.request(venues(3));
  await settle(20);
  assert.equal(h.queue.status().cached, 0);
  h.advance(20000);
  await settle(30);
  assert.equal(h.queue.status().cached, 3, 'the batch was retried after the connection came back');
});

test('a not-configured endpoint switches the feature off for the session, silently and once', async () => {
  let calls = 0;
  const h = harness({ send: async () => { calls += 1; return { ok: false, off: true }; } });
  h.queue.request(venues(30));
  await settle(30);
  // At most the batches already on the wire when the first 503 landed; the
  // three remaining pages of a 30-venue trip are dropped, not sent.
  assert.ok(calls <= L.PLACES_CONCURRENCY, `stopped after ${calls} batches, not all 3`);
  const afterOff = calls;
  h.queue.request(venues(30));
  await settle(30);
  assert.equal(calls, afterOff, 'and later renders ask for nothing at all');
  assert.equal(h.queue.status().off, true);
});

// ---------- generations / trip switching ----------

test('switching trips retires queued work but keeps what is already paid for', async () => {
  // Every batch hangs, so whatever concurrency allows is on the wire and the
  // rest of trip A is unambiguously still queued.
  const pending = [];
  const h = harness({
    send: (queries) => new Promise(r => pending.push(() => r({ ok: true, results: queries.map(okResult) }))),
  });

  h.queue.setGeneration(1);
  h.queue.request(venues(40));          // trip A: some batches on the wire, rest queued
  await settle(10);
  const onWire = pending.length;
  assert.ok(onWire > 0 && onWire <= L.PLACES_CONCURRENCY);
  assert.ok(h.queue.status().queued > 0, 'trip A left work queued behind the wire');

  h.queue.setGeneration(2);             // the traveller switches to trip B
  assert.equal(h.queue.status().queued, 0, 'trip A\'s unsent lookups are dropped, not billed');

  // The in-flight batches were already paid for, so they still land and are usable.
  for (const r of pending) r();
  await settle(30);
  assert.equal(pending.length, onWire, 'and no further batch was sent for the retired trip');
  assert.equal(h.queue.status().cached, onWire * L.PLACES_BATCH_MAX);
});

test('a result landing after a trip switch can only ever describe the venue it names', async () => {
  // The queue is keyed by VENUE, never by trip, which is what makes a late
  // result safe: it can populate the same venue on the new trip and can never
  // attach itself to a different card.
  const h = harness();
  h.queue.setGeneration(1);
  h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  h.queue.setGeneration(2);
  assert.equal(h.queue.get('ichiran shibuya tokyo').name, 'Ichiran Shibuya Tokyo');
  assert.equal(h.queue.get('some other venue'), undefined);
});

// ---------- what must never be stored ----------

test('the queue keeps no persistent record of anything Google returned', async () => {
  // Google Maps Platform ToS 3.2.3(b) plus Service Specific Terms 14.3: place
  // IDs and lat/lon may be kept, ratings and names may not. The queue holds
  // results in memory for the life of the page and offers no way to serialize
  // them; this asserts the SHAPE that keeps that true.
  const h = harness();
  h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  const api = Object.keys(h.queue).sort();
  assert.ok(!api.some(k => /save|persist|serialize|toJSON|export/i.test(k)),
    'the queue exposes no persistence hook: ' + api.join(', '));
  assert.equal(typeof h.queue.get('ichiran shibuya tokyo'), 'object');
});

test('a no_match is a session tombstone, so a category is asked about exactly once', async () => {
  let calls = 0;
  const h = harness({
    send: async (queries) => {
      calls += 1;
      return { ok: true, results: queries.map(q => ({ query: q, status: 'no_match', reason: 'generic_query' })) };
    },
  });
  h.queue.request(['local ramen restaurant']);
  await settle(20);
  for (let i = 0; i < 10; i++) h.queue.request(['local ramen restaurant']);
  await settle(20);
  assert.equal(calls, 1);
});

// ---------- status reporting ----------

test('status reports the scope the server named, which is what the UI explains', async () => {
  const h = harness({ send: async () => ({ ok: false, status: 429, scope: 'global_month' }) });
  h.queue.request(['Ichiran Shibuya Tokyo']);
  await settle(20);
  const st = h.queue.status();
  assert.equal(st.scope, 'global_month');
  assert.equal(st.paused, true);
  assert.equal(st.off, false, 'a quota pause is not the same as an unconfigured endpoint');
});
