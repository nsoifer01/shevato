// The reference baselines in scripts/calibration-report.mjs.
//
// They exist to say whether the engine ranks players better than a naive rule
// a manager could compute on a napkin. That comparison is worthless the moment
// a baseline reads the gameweek it predicts, because a leaking baseline wins
// every ranking question and makes the engine look broken. So the first test
// here mutates every row from the predicted gameweek on and asserts that no
// baseline moves; the rest pin the arithmetic the audit's numbers were read
// from.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDataset } from '../js/engine/backtest.js';
import {
  createReferenceTracker, referenceMetrics, pairedDifferences, referenceSections,
} from '../scripts/calibration-report.mjs';

const base = {
  name: 'x', teamName: 'Alpha', opponentTeam: 2, wasHome: true, kickoff: '2024-08-01T14:00:00Z',
  starts: 1, valueTenths: 50, selected: 1000, bonus: 0, bps: 10, saves: 0, goalsScored: 0, assists: 0,
  cleanSheets: 0, goalsConceded: 0, yellowCards: 0, redCards: 0, ownGoals: 0, penaltiesSaved: 0,
  penaltiesMissed: 0, xG: 0, xA: 0, xGC: 0, teamHScore: 1, teamAScore: 0,
};

// rows: [gw, playerId, minutes, points, fixtureId?]
function season(label, rows, codes) {
  const dataset = buildDataset({
    season: label,
    rows: rows.map(([gw, playerId, minutes, totalPoints, fixtureId = gw]) => ({
      ...base, gw, playerId, position: 3, minutes, totalPoints, fixtureId, name: `P${playerId}`,
    })),
  });
  for (const [id, code] of Object.entries(codes)) dataset.players.get(Number(id)).code = code;
  return dataset;
}

// Last season: player 1 (code 100) scored 6 over 2 rows; player 9 (code 900)
// left the league. This season: player 1 returns, player 2 is a new signing.
const PRIOR = season('prior', [[1, 1, 90, 2], [2, 1, 90, 4], [1, 9, 90, 10]], { 1: 100, 9: 900 });
const ROWS = [
  [1, 1, 90, 3], [1, 2, 0, 0],
  [2, 1, 90, 7], [2, 2, 30, 1],
  [3, 1, 0, 0], [3, 2, 90, 5],
  [4, 1, 90, 2], [4, 2, 90, 9],
  [5, 1, 90, 12], [5, 2, 90, 1],
];
const CURRENT = season('current', ROWS, { 1: 100, 2: 200 });

function predictionsAt(dataset, gw, ids = [1, 2]) {
  const tracker = createReferenceTracker(dataset, PRIOR);
  for (let g = 1; g < gw; g++) tracker.absorb(g);
  return ids.map(id => tracker.predict(id, 1));
}

test('no baseline for gameweek g reads gameweek g or anything after it', () => {
  for (let gw = 1; gw <= 5; gw++) {
    // Every outcome from gw on is replaced with something wildly different.
    const scrambled = season('current', ROWS.map(([g, id, m, p]) => (g >= gw ? [g, id, 90 - m, p * 7 + 13] : [g, id, m, p])), { 1: 100, 2: 200 });
    assert.deepEqual(predictionsAt(scrambled, gw), predictionsAt(CURRENT, gw), `gameweek ${gw} moved when only its future did`);
  }
  // And the guard is not vacuous: changing a PAST gameweek does move it.
  const pastChanged = season('current', ROWS.map(([g, id, m, p]) => (g === 1 ? [g, id, m, p + 10] : [g, id, m, p])), { 1: 100, 2: 200 });
  assert.notDeepEqual(predictionsAt(pastChanged, 3), predictionsAt(CURRENT, 3));
});

test('points per club match falls back to last season by code, then reads this season only', () => {
  const [one, two] = predictionsAt(CURRENT, 1);
  assert.equal(one.ptsPerClubMatch, 3, 'gameweek 1: last season 6 points over 2 club matches');
  assert.equal(one.newSigning, false);
  assert.equal(two.ptsPerClubMatch, 0, 'a new signing with no rows predicts nothing');
  assert.equal(two.newSigning, true);
  assert.equal(one.minutesPerMatch, null);

  const [a, b] = predictionsAt(CURRENT, 4);
  assert.equal(a.ptsPerClubMatch, (3 + 7 + 0) / 3, 'season to date, a blank match counted in the denominator');
  assert.equal(b.ptsPerClubMatch, (0 + 1 + 5) / 3);
  // Per appearance: the 0-minute match is not an appearance.
  assert.equal(a.ppgSeason, (3 + 7) / 2);
  assert.equal(b.ppgSeason, (1 + 5) / 2);
  assert.equal(a.minutesPerMatch, 60);
});

test('last-five reads only the five most recent appearances, and a double gameweek doubles every rule', () => {
  const rows = [];
  for (let gw = 1; gw <= 7; gw++) rows.push([gw, 1, 90, gw]);
  const ds = season('long', rows, { 1: 100 });
  const tracker = createReferenceTracker(ds, PRIOR);
  for (let g = 1; g <= 7; g++) tracker.absorb(g);
  const single = tracker.predict(1, 1);
  assert.equal(single.ppgLast5, (3 + 4 + 5 + 6 + 7) / 5);
  assert.equal(single.ppgSeason, 4);
  const double = tracker.predict(1, 2);
  assert.equal(double.ptsPerClubMatch, 2 * single.ptsPerClubMatch);
  assert.equal(double.ppgLast5, 2 * single.ppgLast5);
});

// Scored rows in the shape calibration-report produces.
function scored(gw, id, xPoints, ref, points, extra = {}) {
  return {
    season: 's', gw, id, position: 3, fixtures: 1, xPoints, points, minutes: points > 0 ? 90 : 0,
    rankable: true, price: 50, newSigning: false, minutesPerMatch: 90,
    reference: { ptsPerClubMatch: ref, ppgSeason: ref, ppgLast5: ref }, ...extra,
  };
}

test('accuracy, ranking and captaincy are measured per deadline on identical rows', () => {
  const rows = [
    // Deadline 2: the engine ranks the 10-pointer first, the baseline the 1-pointer.
    scored(2, 1, 5, 1, 10, { price: 80 }), scored(2, 2, 2, 4, 1), scored(2, 3, 1, 2, 0),
    // Deadline 3: both pick the same captain.
    scored(3, 1, 4, 4, 6, { price: 80 }), scored(3, 2, 1, 1, 2), scored(3, 3, 0, 0, 0),
  ];
  const m = referenceMetrics(rows);
  assert.equal(m.engine.n, 6);
  assert.equal(m.engine.deadlines, 2);
  assert.equal(m.engine.captain, (10 + 6) / 2);
  assert.equal(m.ptsPerClubMatch.captain, (1 + 6) / 2);
  assert.equal(m.engine.captainPremium, 8, 'the only 7.0m+ player is the 7.0m+ captain both weeks');
  const errors = [5 - 10, 2 - 1, 1 - 0, 4 - 6, 1 - 2, 0 - 0];
  assert.ok(Math.abs(m.engine.bias - errors.reduce((s, e) => s + e, 0) / 6) < 1e-12);
  assert.ok(Math.abs(m.engine.mae - errors.reduce((s, e) => s + Math.abs(e), 0) / 6) < 1e-12);
  assert.ok(Math.abs(m.engine.rmse - Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / 6)) < 1e-12);
  assert.equal(m.engine.spearman, 1, 'the engine orders both deadlines perfectly');

  const p = pairedDifferences(rows, 'ptsPerClubMatch');
  assert.equal(p.captain.n, 2);
  assert.equal(p.captain.wins, 1);
  assert.equal(p.captain.ties, 1);
  assert.equal(p.captain.losses, 0);
  assert.equal(p.captain.mean, (10 - 1) / 2);
  assert.ok(p.spearman.mean > 0);
});

test('segments split the rows the way their titles say', () => {
  const rows = [
    scored(1, 1, 1, 1, 1), scored(2, 2, 1, 1, 1, { newSigning: true }), scored(4, 3, 1, 1, 1, { minutesPerMatch: 10 }),
    scored(5, 4, 1, 1, 1, { fixtures: 2 }), scored(6, 5, 1, 1, 1, { position: 2 }),
  ];
  const sections = Object.fromEntries(referenceSections(rows, { seasons: ['s'] }).map(s => [s.key, s.rows.map(r => r.id)]));
  assert.deepEqual(sections.all, [1, 2, 3, 4, 5]);
  assert.deepEqual(sections['gw2+'], [2, 3, 4, 5], 'gameweek 1 is outside every GW 2 on table');
  assert.deepEqual(sections.newSignings, [2]);
  assert.deepEqual(sections.lowMinutes, [3]);
  assert.deepEqual(sections.regulars, [4, 5]);
  assert.deepEqual(sections.doubleGameweek, [4]);
  assert.deepEqual(sections['position:DEF'], [5]);
});
