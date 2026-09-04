// The canonical "expected final points this gameweek", and the contract that
// every other xP total on a plan is a NAMED COMPONENT of it.
//
// This file exists because the reported gameweek total used to be
// `xPointsXi + captainExtra + chipBonus`, which silently omitted two things
// FPL actually pays:
//
//   - auto-substitutions, when a starter plays no minutes
//   - vice-captain succession, when the captain plays no minutes
//
// Both terms are exactly zero while `pAppear` is pinned at 1, which is the only
// reason the omission was invisible on live data (see FINDINGS and registry
// entries 23 and 24). The moment absence probabilities become realistic the
// headline can fall while the team's true expectation RISES, which is the
// failure this file pins shut.
//
// The reference for every assertion is `scoreGameweek` in backtest.js, which
// scores a REAL gameweek from real minutes. If the two ever disagree about what
// FPL pays, backtest.js is right and this is wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import { gameweekPoints } from '../js/engine/planner.js';
import { optimizeLineup } from '../js/engine/lineup.js';
import { chooseCaptain } from '../js/engine/captain.js';

const here = dirname(fileURLToPath(import.meta.url));
const rules = buildRules(JSON.parse(readFileSync(join(here, 'fixtures', 'bootstrap.json'), 'utf8')));

// --- the pure contract ------------------------------------------------------

// A trajectory row, as chips.js builds one.
const row = ({ xi = 50, autosubs = 0, captaincy = 5, bench = 10, captainExtra = 5 }) => ({
  xPointsXi: xi, xPointsAutosubs: autosubs, xPointsCaptaincy: captaincy,
  xPointsBench: bench, captainExtra,
});

test('A. with nobody at risk the canonical total is the old eleven-plus-armband number', () => {
  // pAppear 1 everywhere means no substitution can happen and the vice can
  // never inherit, so xPointsAutosubs is 0 and xPointsCaptaincy collapses to
  // the captain's own points. This is the case live data is in today, and it is
  // why the correction is a no-op on the shipped model.
  const r = row({ xi: 49.6991, autosubs: 0, captaincy: 4.9553, captainExtra: 4.9553 });
  const got = gameweekPoints(r, null, 0);
  assert.ok(Math.abs(got.xPointsGw - (49.6991 + 4.9553)) < 1e-12);
  assert.equal(got.xPointsAutosubs, 0);
  assert.equal(got.xPointsGw, r.xPointsXi + r.captainExtra, 'identical to the pre-2026-09-04 formula');
});

test('B. auto-substitution recovery is part of the expected total', () => {
  const got = gameweekPoints(row({ xi: 46.5918, autosubs: 3.6487, captaincy: 5.3404 }), null, 0);
  assert.ok(Math.abs(got.xPointsGw - (46.5918 + 3.6487 + 5.3404)) < 1e-12);
  // And the old formula would have reported 4.35 points less on the same squad,
  // which is the bug: a BETTER model reading as a worse team.
  assert.ok(got.xPointsGw > 46.5918 + 4.6415, 'the canonical total exceeds eleven-plus-captain');
});

test('E/F. the armband term is the captain when he plays and the vice when he does not', () => {
  // captain.js owns this; the gameweek total just has to consume the right
  // field. A captain certain to play contributes only himself; a doubtful one
  // contributes the vice in proportion to his own absence.
  const certain = gameweekPoints(row({ captaincy: 9, captainExtra: 9 }), null, 0);
  const doubtful = gameweekPoints(row({ captaincy: 9 + 0.4 * 7, captainExtra: 9 }), null, 0);
  assert.ok(Math.abs(doubtful.xPointsCaptaincy - certain.xPointsCaptaincy - 2.8) < 1e-12);
  // Both absent: the vice's own xPoints already carry his appearance
  // probability, so a vice who cannot play contributes nothing.
  const bothOut = gameweekPoints(row({ captaincy: 9 + 0.4 * 0, captainExtra: 9 }), null, 0);
  assert.equal(bothOut.xPointsCaptaincy, 9);
});

test('G. bench boost pays the bench INSTEAD of auto-substitutions, never as well', () => {
  // FPL makes no substitutions under bench boost because all fifteen score;
  // scoreGameweek in backtest.js skips applyAutoSubs entirely for this chip.
  const r = row({ xi: 50, autosubs: 3, captaincy: 6, bench: 12 });
  const boosted = gameweekPoints(r, 'bboost', 0);
  assert.equal(boosted.xPointsAutosubs, 0, 'no substitution is made under bench boost');
  assert.ok(Math.abs(boosted.xPointsGw - (50 + 6 + 12)) < 1e-12);
  // The same squad without the chip keeps its auto-subs and is not paid a bench.
  const plain = gameweekPoints(r, null, 0);
  assert.ok(Math.abs(plain.xPointsGw - (50 + 3 + 6)) < 1e-12);
  assert.equal(plain.xPointsBenchPaid, 0);
});

test('H. triple captain pays two extra copies of the armband, vice succession included', () => {
  const r = row({ xi: 50, autosubs: 2, captaincy: 7 });
  const tripled = gameweekPoints(r, '3xc', 0);
  assert.ok(Math.abs(tripled.xPointsGw - (50 + 2 + 2 * 7)) < 1e-12);
  assert.equal(tripled.xPointsCaptaincy, 14, 'two extra copies, so three in total with the eleven');
  // Wildcard and free hit change the squad, never the scoring.
  for (const chip of ['wildcard', 'freehit']) {
    assert.equal(gameweekPoints(r, chip, 0).xPointsGw, gameweekPoints(r, null, 0).xPointsGw);
  }
});

test('a hit is charged once, on the canonical total', () => {
  const got = gameweekPoints(row({ xi: 50, autosubs: 2, captaincy: 6 }), null, 4);
  assert.ok(Math.abs(got.xPointsNet - (got.xPointsGw - 4)) < 1e-12);
});

// --- wired end to end -------------------------------------------------------

const SQUAD_POSITIONS = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4];
const squadIds = SQUAD_POSITIONS.map((_, i) => i + 1);
const positionOf = id => SQUAD_POSITIONS[id - 1];

function projectionsOf(rows, gw = 1) {
  const byPlayer = new Map(rows.map(r => [r.playerId, [r]]));
  return { gwFrom: gw, gwTo: gw, byPlayer, get: (id, g) => (byPlayer.get(id) && g === gw ? byPlayer.get(id)[0] : null) };
}
const proj = (playerId, xPoints, pAppear = 1) => ({
  playerId, gw: 1, fixtures: [{ fixtureId: 1, fdr: 3 }], pAppear, pStart: pAppear,
  xMins: 90 * pAppear, xPoints, sd: 0, ceiling: xPoints * 1.8, confidence: 'high',
});

test('C/D. the wired components carry FPL legality: only a legal substitute recovers', () => {
  // Three at the back with one doubtful defender, and a bench whose FIRST
  // outfield player is a midfielder who cannot legally replace him. The
  // recovery must come from the defender behind him, at HIS points.
  const rows = [
    proj(1, 4), proj(2, 1),
    proj(3, 4), proj(4, 4), proj(5, 2.0, 0.5),
    proj(6, 1.5), proj(7, 0.5),
    proj(8, 6), proj(9, 6), proj(10, 6), proj(11, 6), proj(12, 5.0),
    proj(13, 6), proj(14, 6), proj(15, 6),
  ];
  const p = projectionsOf(rows);
  const lineup = optimizeLineup(squadIds, p, 1, rules, { positionOf, riskAversion: 0, minutesRiskWeight: 0 });
  assert.equal(lineup.formation, '3-4-3');
  // 0.5 chance the defender misses, and the 1.5 defender is the only legal
  // replacement: 0.75, not 0.5 x 5.0 from the midfielder ahead of him.
  assert.ok(Math.abs(lineup.autosubValue - 0.75) < 1e-9, `autosubValue ${lineup.autosubValue}`);

  const captaincy = chooseCaptain(lineup.startingXI, p, 1, null, { positionOf });
  const built = gameweekPoints({
    xPointsXi: lineup.xPoints,
    xPointsAutosubs: lineup.autosubValue,
    xPointsCaptaincy: captaincy.xPointsCaptaincy,
    xPointsBench: 0,
    captainExtra: 0,
  }, null, 0);
  assert.ok(Math.abs(built.xPointsGw - (lineup.xPoints + 0.75 + captaincy.xPointsCaptaincy)) < 1e-9);
});

test('D. a doubtful goalkeeper is covered by the reserve keeper and by nobody else', () => {
  // The reserve keeper is the only legal replacement for a keeper, so the whole
  // recovery is his: 0.4 x his conditional points.
  const rows = [
    proj(1, 3.0, 0.6), proj(2, 2.0, 1),
    proj(3, 4), proj(4, 4), proj(5, 4), proj(6, 1), proj(7, 1),
    proj(8, 6), proj(9, 6), proj(10, 6), proj(11, 6), proj(12, 5),
    proj(13, 6), proj(14, 6), proj(15, 1),
  ];
  const lineup = optimizeLineup(squadIds, projectionsOf(rows), 1, rules, {
    positionOf, riskAversion: 0, minutesRiskWeight: 0,
  });
  assert.equal(lineup.bench.gk, 2, 'the 2.0 keeper is in reserve');
  assert.ok(Math.abs(lineup.autosubValue - 0.4 * 2.0) < 1e-9,
    `only the reserve keeper can cover a keeper: expected 0.8, got ${lineup.autosubValue}`);
});
