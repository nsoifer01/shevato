import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  goalCountVector,
  cmpRateForMean,
  pZeroGoals,
  projectFixture,
  fixtureContext,
  fixtureExpectedGoals,
  expectedGoals,
  MAX_GOALS,
} from '../js/engine/fixtures.js';
import { poissonVector } from '../js/engine/ml.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { buildGameState } from '../js/engine/normalize.js';
import { assembleSampleBundle } from '../js/data/sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

function strengthOf(entries, modelOptions = null) {
  const s = {
    asOfGw: 1,
    source: 'prior',
    leagueMeanGoals: 1.4,
    homeAdvantage: 1.2,
    matchesUsed: 0,
    teams: new Map(entries.map(e => [e.id, { teamId: e.id, attack: e.attack, defence: e.defence }])),
    params: {},
  };
  if (modelOptions) s.modelOptions = modelOptions;
  return s;
}

const TEAMS = [
  { id: 1, attack: 1.5, defence: 0.7 },
  { id: 2, attack: 0.8, defence: 1.3 },
  { id: 3, attack: 1.0, defence: 1.0 },
  { id: 4, attack: 1.1, defence: 0.9 },
];

const mean = (v) => v.reduce((s, p, k) => s + k * p, 0);
const variance = (v) => { const m = mean(v); return v.reduce((s, p, k) => s + p * (k - m) ** 2, 0); };

// ---------------------------------------------------------------------------
// Conway-Maxwell-Poisson
// ---------------------------------------------------------------------------

test('CMP keeps the expected goals: the mean equals the model expectation to 1e-6', () => {
  // The whole point of the candidate is that ONLY the shape moves. If the mean
  // drifted, the dispersion arm would also be a level change, and a level
  // change is a different (and already rejected) kind of experiment.
  for (const nu of [0.7, 0.9, 1.17, 1.4, 2.0]) {
    for (const lambda of [0.15, 0.6, 1.0, 1.45, 2.3, 3.8]) {
      const v = goalCountVector(lambda, nu, 80);
      assert.ok(Math.abs(mean(v) - lambda) < 1e-6, `nu ${nu} lambda ${lambda}: mean ${mean(v)}`);
      assert.ok(Math.abs(v.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    }
  }
});

test('nu = 1 is the shipped Poisson exactly, bit for bit', () => {
  for (const lambda of [0, 0.3, 1.2, 2.7]) {
    assert.deepEqual(goalCountVector(lambda, 1, MAX_GOALS), poissonVector(lambda, MAX_GOALS));
    assert.equal(pZeroGoals(lambda, 1), Math.exp(-lambda));
  }
  assert.equal(cmpRateForMean(1.3, 1), 1.3);
  const plain = projectFixture(strengthOf(TEAMS), 1, 2);
  const nuOne = projectFixture(strengthOf(TEAMS, { goalDispersion: 1 }), 1, 2);
  assert.deepEqual(nuOne, plain);
});

test('nu above 1 narrows the goal count and moves P(0), with the mean fixed', () => {
  const lambda = 1.4;
  const pois = goalCountVector(lambda, 1, 80);
  const under = goalCountVector(lambda, 1.17, 80);
  assert.ok(variance(under) < variance(pois), 'underdispersed means a smaller variance');
  assert.ok(under[0] < pois[0], 'and fewer blanks at a mean above one goal');
  assert.ok(Math.abs(variance(pois) - lambda) < 1e-9);
});

test('the truncated vector folds its tail like poissonVector and sums to one', () => {
  const v = goalCountVector(4.5, 0.8, MAX_GOALS);
  assert.equal(v.length, MAX_GOALS + 1);
  assert.ok(Math.abs(v.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.deepEqual(goalCountVector(0, 1.3, 4), [1, 0, 0, 0, 0]);
  assert.throws(() => goalCountVector(1, -1), /positive number/);
});

test('a dispersion on the Strength reaches the fixture distribution', () => {
  const p = projectFixture(strengthOf(TEAMS, { goalDispersion: 1.17 }), 1, 2);
  const { xGH, xGA } = expectedGoals(strengthOf(TEAMS), 1, 2);
  assert.equal(p.xGH, xGH);
  assert.equal(p.xGA, xGA);
  assert.equal(p.pCSHome, goalCountVector(xGA, 1.17)[0]);
  assert.ok(Math.abs(p.pWinHome + p.pDraw + p.pWinAway - 1) < 1e-9);
});

// ---------------------------------------------------------------------------
// The odds blend
// ---------------------------------------------------------------------------

const GAME_STATE = {
  nextEvent: 5,
  fixtures: [
    { id: 51, event: 5, teamH: 1, teamA: 2, teamHDifficulty: 2, teamADifficulty: 4, kickoff: '2025-09-20T14:00:00Z' },
    { id: 52, event: 5, teamH: 3, teamA: 4, teamHDifficulty: 3, teamADifficulty: 3, kickoff: '2025-09-20T14:00:00Z' },
    { id: 61, event: 6, teamH: 2, teamA: 1, teamHDifficulty: 4, teamADifficulty: 2, kickoff: '2025-09-27T14:00:00Z' },
  ],
};

function withOdds(rows) {
  return { ...GAME_STATE, fixtureOdds: new Map(rows.map(r => [r.id, { xGH: r.xGH, xGA: r.xGA, fetchedAt: '2025-09-19T16:00:00Z' }])) };
}

test('the blend is w * odds + (1 - w) * model on the decided gameweek', () => {
  const s = strengthOf(TEAMS, { odds: { weight: 0.6 } });
  const gs = withOdds([{ id: 51, xGH: 1.1, xGA: 1.3 }]);
  const model = expectedGoals(s, 1, 2);
  const ctx = fixtureContext(gs, s, 1, 5)[0];
  assert.ok(Math.abs(ctx.teamXg - (0.6 * 1.1 + 0.4 * model.xGH)) < 1e-12);
  assert.ok(Math.abs(ctx.opponentXg - (0.6 * 1.3 + 0.4 * model.xGA)) < 1e-12);
  // A fixture without odds falls back to the model.
  const other = fixtureContext(gs, s, 3, 5)[0];
  assert.equal(other.teamXg, expectedGoals(s, 3, 4).xGH);
});

test('odds attached to the GameState are ignored unless the arm switches them on', () => {
  const gs = withOdds([{ id: 51, xGH: 0.4, xGA: 2.9 }]);
  const plain = strengthOf(TEAMS);
  assert.deepEqual(fixtureContext(gs, plain, 1, 5), fixtureContext(GAME_STATE, plain, 1, 5));
});

test('LEAKAGE: odds never reach a gameweek beyond the one being decided', () => {
  // Even if a caller attached a later round's prices, which the replay's gate
  // never does, the fixture model reads them only for nextEvent.
  const s = strengthOf(TEAMS, { odds: { weight: 1 } });
  const gs = withOdds([{ id: 61, xGH: 3.5, xGA: 0.2 }]);
  const later = fixtureContext(gs, s, 2, 6)[0];
  assert.equal(later.teamXg, expectedGoals(s, 2, 1).xGH);
  assert.equal(fixtureExpectedGoals(gs, s, GAME_STATE.fixtures[2]).oddsWeight, undefined);
});

test('the blend changes ORDER between fixtures, not only the level', () => {
  // The model rates club 1 at home to 2 as the better attacking fixture; the
  // market says the opposite. A level correction could not swap them.
  const s = strengthOf(TEAMS, { odds: { weight: 1 } });
  const modelA = expectedGoals(s, 1, 2).xGH;
  const modelB = expectedGoals(s, 3, 4).xGH;
  assert.ok(modelA > modelB);
  const gs = withOdds([{ id: 51, xGH: 1.0, xGA: 1.0 }, { id: 52, xGH: 2.0, xGA: 1.0 }]);
  const a = fixtureContext(gs, s, 1, 5)[0].teamXg;
  const b = fixtureContext(gs, s, 3, 5)[0].teamXg;
  assert.ok(b > a, `blended ${a} vs ${b}`);
});

// ---------------------------------------------------------------------------
// Bit identity on a real GameState
// ---------------------------------------------------------------------------

const SAMPLE_FILES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];

function sampleState() {
  const bundle = assembleSampleBundle(Object.fromEntries(
    SAMPLE_FILES.map(name => [name, read('..', 'data', 'sample', `${name}.json`)]),
  ));
  return buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
}

function projectAll(gameState, strength) {
  const gw = gameState.nextEvent;
  const p = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw + 2 });
  return [...p.byPlayer.entries()].map(([id, rows]) => [id, rows.map(r => [r.xPoints, r.sd, r.ceiling, r.components])]);
}

test('BIT IDENTITY: modelOptions absent, {} and inert switches project identically', () => {
  const gameState = sampleState();
  const gw = gameState.nextEvent;
  const base = buildStrength(gameState, { asOfGw: gw });
  const empty = buildStrength(gameState, { asOfGw: gw, modelOptions: {} });
  assert.deepEqual(empty, base);
  assert.equal('modelOptions' in empty, false);
  const reference = projectAll(gameState, base);
  assert.deepEqual(projectAll(gameState, empty), reference);
  // nu = 1 is the shipped model; odds without odds data (the live page, which
  // never fetches any) leave every fixture on the model.
  assert.deepEqual(projectAll(gameState, buildStrength(gameState, { asOfGw: gw, modelOptions: { goalDispersion: 1 } })), reference);
  assert.deepEqual(projectAll(gameState, buildStrength(gameState, { asOfGw: gw, modelOptions: { odds: { weight: 0.65 } } })), reference);
});
