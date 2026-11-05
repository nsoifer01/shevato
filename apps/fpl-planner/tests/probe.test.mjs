// The health probe's invariants as a library (scripts/lib/probe.mjs), shared
// by scripts/evidence-probe.mjs and the scheduled Netlify function. Judged on
// the real 2026/27 gameweek 4 deadline payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProbe, payloadShapeFailures } from '../scripts/lib/probe.mjs';
import { deadlinePayload } from './helpers/xp-calibration-fixture.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const loadShipped = async () => JSON.parse(readFileSync(join(APP, 'data', 'opening-baseline.json'), 'utf8'));
const { bootstrap, fixtures, fetchedAt } = deadlinePayload(4);

test('a healthy deadline payload passes every invariant that applies, and the report says so', async () => {
  const r = await runProbe({ bootstrap, fixtures, fetchedAt, now: fetchedAt, source: 'files', loadShipped });
  assert.deepEqual(r.failed, []);
  assert.equal(r.usable, true);
  assert.ok(r.checks.length >= 15);
  assert.equal(r.lines[r.lines.length - 1], 'OK: every invariant holds.');
  assert.ok(r.reading.best11 > 30 && r.reading.best11 < 100);
});

test('a fixture list older than the events fails its named invariant', async () => {
  const finished = bootstrap.events.find((e) => e.finished).id;
  const stale = fixtures.map((f) => (f.event === finished ? { ...f, finished: false, finished_provisional: false } : f));
  const r = await runProbe({ bootstrap, fixtures: stale, fetchedAt, now: fetchedAt, source: 'files', loadShipped });
  assert.deepEqual(r.failed.map((f) => f.name), ['every fixture of a finished gameweek has been played']);
  assert.match(r.lines[r.lines.length - 2], /PROBLEM|every fixture/);
});

test('change detection fires when the best eleven moves a long way with nothing to explain it', async () => {
  const first = await runProbe({ bootstrap, fixtures, fetchedAt, now: fetchedAt, source: 'files', loadShipped });
  const prev = { ...first.reading, best11: first.reading.best11 * 2 };
  const r = await runProbe({ bootstrap, fixtures, fetchedAt, now: fetchedAt, source: 'files', loadShipped, prev });
  assert.deepEqual(r.failed.map((f) => f.name), ['the best eleven has not moved without a reason']);
});

test('a non-payload is refused by shape before anything is built', () => {
  assert.equal(payloadShapeFailures({ error: 'updating' }, []).length, 2);
  assert.deepEqual(payloadShapeFailures(bootstrap, fixtures), []);
});

// Ledger row 44: a pool-shape refusal on this season's evidence withholds
// advice from every manager, so the probe fails on it whichever way it is
// wrong. Both directions on real payloads.
const SHAPE_CHECK = "the pool's shape does not withhold the plan";
const gw10 = (() => {
  const dir = join(APP, 'tests', 'fixtures', 'gw10-2026');
  const J = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const expand = ({ fields, rows }) => rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));
  const raw = J('bootstrap.json');
  return { bootstrap: { ...raw, elements: expand(raw.elements) }, fixtures: expand(J('fixtures.json')), fetchedAt: '2026-11-05T13:10:22.000Z' };
})();

test('GW10 2026/27, one defender above every attacker: the shape check passes and the ladder licenses chips', async () => {
  const r = await runProbe({ ...gw10, now: gw10.fetchedAt, source: 'files', loadShipped });
  const c = r.checks.find((x) => x.name === SHAPE_CHECK);
  assert.ok(c, 'the check ran');
  assert.equal(c.ok, true, `saw ${c.saw}`);
  assert.equal(r.reading.readiness, 'chips', r.lines.join('\n'));
});

test('attacking numerators cleared mid-season (the 2026-08-22 shape): the shape check fails', async () => {
  const CLEARED = ['goals_scored', 'assists', 'expected_goals', 'expected_assists', 'expected_goal_involvements',
    'bonus', 'bps', 'threat', 'creativity', 'ict_index', 'total_points', 'form', 'points_per_game', 'ep_next', 'event_points'];
  const elements = gw10.bootstrap.elements.map((e) => (e.element_type === 3 || e.element_type === 4
    ? { ...e, ...Object.fromEntries(CLEARED.filter((k) => k in e).map((k) => [k, typeof e[k] === 'string' ? '0.0' : 0])) }
    : e));
  const r = await runProbe({ ...gw10, bootstrap: { ...gw10.bootstrap, elements }, now: gw10.fetchedAt, source: 'files', loadShipped });
  const c = r.checks.find((x) => x.name === SHAPE_CHECK);
  assert.equal(c.ok, false, r.lines.join('\n'));
  assert.match(c.saw, /projection_inverted/);
});
