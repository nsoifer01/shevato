// The deadline archive (scripts/lib/archive.mjs), hermetically.
//
// WHY THESE TESTS
//
// The archive is only worth anything if three things hold all season without
// anyone watching: a payload once captured is never replaced, an unchanged
// payload is not stored twice (the release has to stay small), and the hourly
// gate captures every deadline inside its final two hours while doing nothing
// the rest of the time. A broken gate does not fail loudly; it silently loses
// deadlines that can never be recaptured. So the gate is driven here through
// a whole simulated deadline, hour by hour, the way the workflow runs it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  seasonLabelFrom, releaseTagFor, compactStamp, snapshotFileName, parseSnapshotFileName,
  buildRecord, encodeRecord, decodeRecord, writeSnapshotFile, emptyManifest, addToManifest,
  assertAppendOnly, parsePayload, assertShape, isGameUpdating, decideCaptures, fetchEndpoint, GATE,
} from '../scripts/lib/archive.mjs';

const H = 3600e3;
const DEADLINE = Date.parse('2026-10-10T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

/** A bootstrap whose GW5 is played and signed off and whose GW6 deadline is DEADLINE. */
function bootstrapAt({ gw6Finished = false } = {}) {
  const events = [];
  for (let gw = 1; gw <= 38; gw++) {
    const ms = gw <= 5 ? Date.parse('2026-08-21T17:30:00Z') + (gw - 1) * 7 * 24 * H : DEADLINE + (gw - 6) * 7 * 24 * H;
    const done = gw <= 5 || (gw === 6 && gw6Finished);
    events.push({ id: gw, deadline_time: iso(ms).replace('.000Z', 'Z'), finished: done, data_checked: done });
  }
  return {
    events,
    teams: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })),
    elements: [{ id: 1, team: 1, element_type: 3, now_cost: 100, total_points: 30 }],
  };
}

/** Run the gate and record whatever it decides, as the workflow would. */
function runGate(manifest, nowMs, bootstrap = bootstrapAt()) {
  const { captures, idle } = decideCaptures({ bootstrap, manifest, now: iso(nowMs) });
  let m = manifest;
  for (const c of captures) {
    for (const endpoint of c.phase === 'live' ? ['live'] : ['bootstrap', 'fixtures']) {
      const capturedAt = iso(nowMs);
      ({ manifest: m } = addToManifest(m, {
        file: snapshotFileName({ phase: c.phase, gw: c.gw, capturedAt, endpoint }),
        endpoint, phase: c.phase, gw: c.gw, deadline: c.deadline, capturedAt,
        // Every bootstrap differs (ownership moves); fixtures do not.
        sha256: endpoint === 'fixtures' ? 'same-fixtures' : `${endpoint}-${nowMs}`,
      }));
    }
  }
  return { manifest: m, captures, idle };
}

test('the season label comes from the first deadline, and names the release', () => {
  assert.equal(seasonLabelFrom(bootstrapAt()), '2026-27');
  assert.equal(seasonLabelFrom({ events: [{ id: 1, deadline_time: '2099-08-15T10:00:00Z' }] }), '2099-00');
  assert.equal(releaseTagFor('2026-27'), 'fpl-archive-2026-27');
  assert.throws(() => seasonLabelFrom({ events: [] }), /season label/);
});

test('file names carry phase, two-digit gameweek, a compact UTC stamp and the endpoint, and parse back', () => {
  assert.equal(compactStamp('2026-10-09T15:30:12.345Z'), '20261009T153012Z');
  const name = snapshotFileName({ phase: 'pre', gw: 6, capturedAt: '2026-10-09T15:30:12.345Z', endpoint: 'bootstrap' });
  assert.equal(name, 'pre-gw06-20261009T153012Z-bootstrap.json.gz');
  assert.deepEqual(parseSnapshotFileName(name), { phase: 'pre', gw: 6, stamp: '20261009T153012Z', endpoint: 'bootstrap' });
  assert.equal(parseSnapshotFileName('pre-gw06-whatever.json'), null);
  assert.throws(() => snapshotFileName({ phase: 'later', gw: 6, capturedAt: '2026-10-09T15:30:12Z', endpoint: 'bootstrap' }), /phase/);
  assert.throws(() => snapshotFileName({ phase: 'pre', gw: 6, capturedAt: 'yesterday', endpoint: 'bootstrap' }), /timestamp/);
});

test('a record keeps the body exactly as served and re-verifies its own hash', () => {
  const raw = '{"elements":[1,2,3]}';
  const rec = buildRecord({
    endpoint: 'bootstrap', url: 'u', phase: 'pre', gw: 6, deadline: '2026-10-10T10:00:00Z',
    capturedAt: '2026-10-09T22:00:00.000Z', serverDate: '2026-10-09T21:59:59.000Z', season: '2026-27', raw,
  });
  const { meta, body } = decodeRecord(encodeRecord(rec));
  assert.deepEqual(body, { elements: [1, 2, 3] });
  assert.equal(meta.capturedAt, '2026-10-09T22:00:00.000Z');
  assert.equal(meta.serverDate, '2026-10-09T21:59:59.000Z');
  assert.equal(meta.deadline, '2026-10-10T10:00:00Z');
  assert.equal(meta.bytes, raw.length);
  // A record whose body no longer matches its hash is not evidence of anything.
  assert.throws(() => decodeRecord(encodeRecord({ ...rec, raw: '{"elements":[1,2,4]}' })), /sha256 mismatch/);
});

test('a snapshot file is never overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fpl-archive-test-'));
  try {
    writeSnapshotFile(dir, 'pre-gw06-20261009T220000Z-bootstrap.json.gz', Buffer.from('first'));
    assert.throws(() => writeSnapshotFile(dir, 'pre-gw06-20261009T220000Z-bootstrap.json.gz', Buffer.from('second')), /EEXIST/);
    assert.equal(readFileSync(join(dir, 'pre-gw06-20261009T220000Z-bootstrap.json.gz'), 'utf8'), 'first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unchanged payload is recorded as a pointer, not stored twice', () => {
  const base = { endpoint: 'fixtures', phase: 'pre', gw: 6, deadline: 'd', sha256: 'abc' };
  let m = emptyManifest('2026-27');
  let r = addToManifest(m, { ...base, file: 'pre-gw06-20261009T040000Z-fixtures.json.gz', capturedAt: '2026-10-09T04:00:00Z' });
  assert.equal(r.store, true);
  m = r.manifest;
  r = addToManifest(m, { ...base, file: 'pre-gw06-20261009T100000Z-fixtures.json.gz', capturedAt: '2026-10-09T10:00:00Z' });
  assert.equal(r.store, false, 'the same bytes are not written again');
  const pointer = r.manifest.entries[1];
  assert.equal(pointer.file, null);
  assert.equal(pointer.sameAs, 'pre-gw06-20261009T040000Z-fixtures.json.gz');
  assert.equal(pointer.capturedAt, '2026-10-09T10:00:00Z', 'the capture itself is still recorded');
  r = addToManifest(r.manifest, { ...base, sha256: 'def', file: 'pre-gw06-20261009T160000Z-fixtures.json.gz', capturedAt: '2026-10-09T16:00:00Z' });
  assert.equal(r.store, true, 'changed bytes are stored');
});

test('the manifest only ever grows: a lost or edited entry is refused', () => {
  let m = emptyManifest('2026-27');
  ({ manifest: m } = addToManifest(m, { file: 'a', sha256: '1', capturedAt: 't' }));
  ({ manifest: m } = addToManifest(m, { file: 'b', sha256: '2', capturedAt: 't' }));
  const grown = addToManifest(m, { file: 'c', sha256: '3', capturedAt: 't' }).manifest;
  assert.doesNotThrow(() => assertAppendOnly(m, grown));
  assert.doesNotThrow(() => assertAppendOnly(null, grown), 'no previous manifest: nothing to lose');
  assert.throws(() => assertAppendOnly(grown, m), /lost entries/);
  const edited = { ...grown, entries: grown.entries.map((e, i) => (i === 0 ? { ...e, capturedAt: 'other' } : e)) };
  assert.throws(() => assertAppendOnly(grown, edited), /entry 0/);
});

test('shape checks refuse the update notice, non-JSON and payloads missing what the app reads', () => {
  assert.equal(isGameUpdating('"The game is being updated."'), true);
  const err = (() => { try { parsePayload('bootstrap', 'The game is being updated.'); } catch (e) { return e; } return null; })();
  assert.ok(err && err.gameUpdating, 'the update notice is flagged so the job can treat it as a retry');
  assert.throws(() => parsePayload('fixtures', '<html>502</html>'), /not JSON/);
  assert.throws(() => assertShape('bootstrap', { events: [], teams: [], elements: [] }), /elements is not a non-empty array/);
  const b = bootstrapAt();
  assert.throws(() => assertShape('bootstrap', { ...b, teams: b.teams.slice(1) }), /19 teams/);
  assert.throws(() => assertShape('bootstrap', { ...b, elements: [{ id: 1 }] }), /no team/);
  assert.doesNotThrow(() => assertShape('bootstrap', b));
  assert.throws(() => assertShape('fixtures', {}), /non-empty array/);
  assert.doesNotThrow(() => assertShape('fixtures', [{ id: 1, team_h: 1, team_a: 2 }]));
  assert.throws(() => assertShape('live', { elements: [{ id: 1 }] }), /stats/);
  assert.throws(() => assertShape('event-status', {}), /status/);
});

function fakeFetch(script) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    return { status: step.status, ok: step.status < 400, text: async () => step.body, headers: { get: (k) => (k === 'date' ? 'Fri, 09 Oct 2026 22:00:00 GMT' : null) } };
  };
  return { impl, calls };
}
const fixturesBody = JSON.stringify([{ id: 1, team_h: 1, team_a: 2 }]);

test('fetching retries 5xx and network errors with backoff, a bounded number of times', async () => {
  const sleeps = [];
  const f = fakeFetch([{ status: 502, body: 'bad gateway' }, new Error('ECONNRESET'), { status: 200, body: fixturesBody }]);
  const got = await fetchEndpoint('fixtures', 'fixtures/', { fetchImpl: f.impl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 4000], 'exponential backoff');
  assert.equal(got.raw, fixturesBody);
  assert.equal(got.serverDate, '2026-10-09T22:00:00.000Z');

  const down = fakeFetch([{ status: 503, body: 'down' }]);
  await assert.rejects(fetchEndpoint('fixtures', 'fixtures/', { fetchImpl: down.impl, sleep: async () => {} }), /HTTP 503/);
  assert.equal(down.calls.length, 4, 'gives up after four attempts');
});

test('the update notice and a 4xx are not retried', async () => {
  const upd = fakeFetch([{ status: 503, body: 'The game is being updated.' }]);
  await assert.rejects(fetchEndpoint('bootstrap', 'bootstrap-static/', { fetchImpl: upd.impl, sleep: async () => {} }), (e) => e.gameUpdating === true);
  assert.equal(upd.calls.length, 1);
  const nf = fakeFetch([{ status: 404, body: 'nope' }]);
  await assert.rejects(fetchEndpoint('live', 'event/99/live/', { fetchImpl: nf.impl, sleep: async () => {} }), /HTTP 404/);
  assert.equal(nf.calls.length, 1);
});

test('the gate: nothing outside the pre window, a first capture inside it, then six-hour spacing', () => {
  let m = emptyManifest('2026-27');
  // GW5 is signed off and has no live capture, so the first run takes it.
  let r = runGate(m, DEADLINE - 30 * H);
  assert.deepEqual(r.captures.map((c) => `${c.phase}${c.gw}`), ['live5']);
  m = r.manifest;
  r = runGate(m, DEADLINE - 29 * H);
  assert.deepEqual(r.captures, []);
  assert.match(r.idle, /outside the 26h pre window/);

  r = runGate(m, DEADLINE - 25.5 * H);
  assert.deepEqual(r.captures.map((c) => `${c.phase}${c.gw}`), ['pre6']);
  m = r.manifest;
  assert.deepEqual(runGate(m, DEADLINE - 21 * H).captures, [], 'four hours later: too soon');
  assert.deepEqual(runGate(m, DEADLINE - 19.5 * H).captures.map((c) => c.phase), ['pre'], 'six hours later');
});

test('the gate always takes one inside the final two hours, even right after a capture', () => {
  let m = emptyManifest('2026-27');
  m = runGate(m, DEADLINE - 30 * H).manifest; // live GW5
  m = runGate(m, DEADLINE - 2.5 * H).manifest; // a pre capture 2.5h out
  const r = runGate(m, DEADLINE - 1.75 * H);
  assert.deepEqual(r.captures.map((c) => c.phase), ['pre']);
  assert.match(r.captures[0].reason, /final 2h/);
  assert.deepEqual(runGate(r.manifest, DEADLINE - 0.75 * H).captures, [], 'and only one');
});

test('the gate takes one post capture within three hours of the deadline, and live once it is signed off', () => {
  let m = emptyManifest('2026-27');
  m = runGate(m, DEADLINE - 30 * H).manifest;
  let r = runGate(m, DEADLINE + 1 * H);
  assert.deepEqual(r.captures.map((c) => `${c.phase}${c.gw}`), ['post6']);
  m = r.manifest;
  assert.deepEqual(runGate(m, DEADLINE + 2 * H).captures, []);
  assert.deepEqual(runGate(emptyManifest('2026-27'), DEADLINE + 4 * H).captures.map((c) => c.phase), ['live'],
    'past the post window only the live capture of GW5 is outstanding');
  r = runGate(m, DEADLINE + 5 * 24 * H, bootstrapAt({ gw6Finished: true }));
  assert.ok(r.captures.some((c) => c.phase === 'live' && c.gw === 6));
});

test('hourly runs at :17 through a whole deadline: about five pre captures, one in the final two hours, one post, no extras', () => {
  let m = emptyManifest('2026-27');
  const start = Date.parse('2026-10-08T00:17:00Z');
  const runs = [];
  for (let t = start; t < DEADLINE + 6 * H; t += H) {
    const r = runGate(m, t);
    m = r.manifest;
    for (const c of r.captures) runs.push({ ...c, t });
  }
  const pre = runs.filter((c) => c.phase === 'pre');
  assert.ok(pre.length >= 4 && pre.length <= 6, `${pre.length} pre captures`);
  assert.ok(pre.every((c) => c.t < DEADLINE && c.t >= DEADLINE - GATE.preWindowHours * H));
  assert.ok(pre.some((c) => c.t >= DEADLINE - GATE.finalHours * H), 'one inside the final two hours');
  assert.equal(runs.filter((c) => c.phase === 'post').length, 1);
  assert.equal(runs.filter((c) => c.phase === 'live').length, 1, 'GW5 live, once');
  // Fixtures did not change all week, so they are stored once and pointed at after.
  const fx = m.entries.filter((e) => e.endpoint === 'fixtures');
  assert.equal(fx.filter((e) => e.file).length, 1);
  assert.ok(fx.slice(1).every((e) => e.file === null && e.sameAs === fx[0].file));
});
