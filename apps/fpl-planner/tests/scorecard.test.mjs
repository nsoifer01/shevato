// The live accuracy scorecard (scripts/lib/archive-scorecard.mjs).
//
// WHY THESE TESTS
//
// The scorecard is the season's only honest measurement of the engine against
// FPL's own projection, and it is only honest for as long as two things hold:
// the metrics are the textbook ones (a wrong Spearman tie rule or a captain
// picked by row order quietly flatters one method), and nothing captured after
// a deadline is ever scored (a post-deadline payload knows the team news, and
// once a match starts it knows the minutes). Both are pinned here on numbers
// small enough to check by hand, and the engine path is run once on the
// committed GW4 capture so the plumbing from payload to report is exercised.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ranks, spearman, methodMetrics, startCalibration, assertPreDeadline, upsertHistory, driftFlags,
  deadlineRows, scoreRows, renderMarkdown,
} from '../scripts/lib/archive-scorecard.mjs';
import { deadlinePayload, liveStats } from './helpers/xp-calibration-fixture.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('ranks share ties, and Spearman is the Pearson correlation of those ranks', () => {
  assert.deepEqual(ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
  close(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  close(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  // Monotone but not linear: Spearman sees order only.
  close(spearman([1, 2, 3, 4], [1, 8, 27, 64]), 1);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null, 'no spread, no correlation');
});

// Four players, small enough to check every number by hand.
const ROWS = [
  { id: 1, name: 'A', engine: 6, naive: 4, fpl: 5, actual: 10, minutes: 90, started: 1, pStart: 0.95 },
  { id: 2, name: 'B', engine: 4, naive: 5, fpl: null, actual: 2, minutes: 90, started: 1, pStart: 0.85 },
  { id: 3, name: 'C', engine: 1, naive: 1, fpl: 1, actual: 0, minutes: 0, started: 0, pStart: 0.2 },
  { id: 4, name: 'D', engine: 6, naive: 0, fpl: 0, actual: 1, minutes: 20, started: 0, pStart: 0.05 },
];

test('bias, MAE, RMSE, 60-minute MAE, top-k and captain on a hand-checked dataset', () => {
  const e = methodMetrics(ROWS, 'engine');
  // errors: -4, +2, +1, +5
  assert.equal(e.n, 4);
  close(e.bias, 1);
  close(e.mae, 3);
  close(e.rmse, Math.sqrt((16 + 4 + 1 + 25) / 4));
  close(e.mae60, 3, 1e-9); // players 1 and 2: |-4| and |2|
  assert.equal(e.n60, 2);
  close(e.top20, 13 / 4, 1e-9); // fewer than 20 rows: all of them
  // Players 1 and 4 tie on 6; the lower id wins, whatever order rows arrive in.
  assert.equal(e.captainId, 1);
  assert.equal(methodMetrics([...ROWS].reverse(), 'engine').captainId, 1);
  assert.equal(e.captainPoints, 10);
});

test('a method with no prediction for a player is scored without him, and says so', () => {
  const f = methodMetrics(ROWS, 'fpl');
  assert.equal(f.n, 3, "player 2 has no ep_next and is left out of FPL's column only");
  close(f.bias, ((5 - 10) + (1 - 0) + (0 - 1)) / 3);
  assert.equal(methodMetrics(ROWS.map((r) => ({ ...r, fpl: null })), 'fpl'), null);
  const all = scoreRows(ROWS);
  assert.equal(all.methods.engine.n, 4);
  assert.equal(all.methods.fpl.n, 3);
});

test('start calibration bins predicted start probability against observed starts', () => {
  const bins = startCalibration(ROWS);
  const bin = (from) => bins.find((b) => b.from === from);
  assert.equal(bin(0).n, 1);
  assert.equal(bin(0.1).n, 1);
  assert.equal(bin(0.7).n, 1);
  assert.equal(bin(0.9).n, 1);
  close(bin(0.9).predicted, 0.95);
  assert.equal(bin(0.9).observed, 1);
  assert.equal(bin(0.1).observed, 0);
  assert.equal(bin(0.3).n, 0);
  assert.equal(bin(0.3).predicted, null);
});

test('the leakage guard refuses anything captured at or after the deadline, by either clock', () => {
  const deadline = '2026-10-10T10:00:00Z';
  assert.doesNotThrow(() => assertPreDeadline({ capturedAt: '2026-10-10T09:00:00Z', serverDate: '2026-10-10T09:00:01Z' }, deadline));
  assert.throws(() => assertPreDeadline({ capturedAt: '2026-10-10T10:00:00Z' }, deadline), /at or after the deadline/);
  assert.throws(() => assertPreDeadline({ capturedAt: '2026-10-11T16:00:00Z' }, deadline), (e) => e.leakage === true);
  // This machine's clock says before; FPL's says after. A skewed clock must
  // not sneak a post-deadline payload through.
  assert.throws(() => assertPreDeadline({ capturedAt: '2026-10-10T09:59:00Z', serverDate: '2026-10-10T10:01:00Z' }, deadline), /FPL dated it/);
  assert.throws(() => assertPreDeadline({ capturedAt: null }, deadline), /no capture time/);
  assert.throws(() => assertPreDeadline({ capturedAt: '2026-10-10T09:00:00Z' }, null), /no deadline/);
});

const hist = (gw, engine, naive, fpl = null) => ({
  season: '2026-27', gw, snapshot: `pre-gw${gw}`, capturedAt: `2026-10-${String(gw).padStart(2, '0')}T08:00:00Z`,
  methods: { engine: { spearman: engine }, naive: { spearman: naive }, fpl: fpl === null ? null : { spearman: fpl } },
});

test('the history keeps one row per snapshot, so a re-run does not double count', () => {
  let h = upsertHistory([], hist(6, 0.6, 0.5));
  h = upsertHistory(h, hist(7, 0.6, 0.5));
  h = upsertHistory(h, { ...hist(6, 0.7, 0.5) });
  assert.equal(h.length, 2);
  assert.equal(h[0].methods.engine.spearman, 0.7, 'the re-scored row replaces the old one');
  assert.deepEqual(h.map((r) => r.gw), [6, 7]);
});

test('drift is flagged after three consecutive gameweeks below a reference, not after two or an interrupted run', () => {
  assert.deepEqual(driftFlags([hist(6, 0.5, 0.6), hist(7, 0.5, 0.6)]), []);
  assert.deepEqual(driftFlags([hist(6, 0.5, 0.6), hist(7, 0.7, 0.6), hist(8, 0.5, 0.6), hist(9, 0.5, 0.6)]), []);
  const flags = driftFlags([hist(6, 0.7, 0.6), hist(7, 0.5, 0.6), hist(8, 0.5, 0.6), hist(9, 0.5, 0.6)]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].reference, 'naive');
  assert.deepEqual(flags[0].gameweeks, ['2026-27 GW7', '2026-27 GW8', '2026-27 GW9']);
  const vsFpl = driftFlags([hist(6, 0.5, 0.4, 0.6), hist(7, 0.5, 0.4, 0.6), hist(8, 0.5, 0.4, 0.6)]);
  assert.deepEqual(vsFpl.map((f) => f.reference), ['fpl']);
  assert.match(renderMarkdown({ title: 't', generatedAt: 'now', results: [], refused: [], drift: vsFpl }), /DRIFT: engine Spearman below FPL's ep_next/);
});

test('the engine path: the rebuilt GW4 deadline scores every player with a fixture, and ep_next only when it is for that gameweek', () => {
  const shipped = JSON.parse(readFileSync(join(APP, 'data', 'opening-baseline.json'), 'utf8'));
  const { bootstrap, fixtures, fetchedAt } = deadlinePayload(4);
  const actuals = new Map([...liveStats(4)].map(([id, s]) => [id, { points: s.total_points, minutes: s.minutes, started: s.starts > 0 ? 1 : 0 }]));
  // The capture keeps no ep_next; give every player one so the column can be seen to be read.
  const withEp = { ...bootstrap, elements: bootstrap.elements.map((e) => ({ ...e, ep_next: String(e.total_points / 3) })) };
  const { rows } = deadlineRows({ bootstrap: withEp, fixtures, capturedAt: fetchedAt, gw: 4, actuals, shipped });
  assert.equal(rows.length, bootstrap.elements.length, 'every club plays in GW4');
  assert.ok(rows.every((r) => Number.isFinite(r.engine) && Number.isFinite(r.naive) && Number.isFinite(r.fpl)));
  const scored = scoreRows(rows);
  // Not a quality bar: a pipeline that scored the wrong gameweek, or joined
  // actuals to the wrong ids, reads near zero.
  assert.ok(scored.methods.engine.spearman > 0.5, `engine Spearman ${scored.methods.engine.spearman}`);
  const poolMean = rows.reduce((a, r) => a + r.actual, 0) / rows.length;
  assert.ok(scored.methods.engine.top20 > 2 * poolMean, `top 20 ${scored.methods.engine.top20} against a pool mean of ${poolMean}`);

  // The same payload planning a different gameweek: its ep_next is not for GW4.
  const shifted = { ...withEp, events: withEp.events.map((e) => ({ ...e, is_next: e.id === 5 })) };
  const other = deadlineRows({ bootstrap: shifted, fixtures, capturedAt: fetchedAt, gw: 4, actuals, shipped });
  assert.ok(other.rows.every((r) => r.fpl === null), 'never a guess');
});
