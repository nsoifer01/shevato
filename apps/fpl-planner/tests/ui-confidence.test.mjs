import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessConfidence, CONFIDENCE_PARAMS, BAND_LABELS } from '../js/engine/confidence.js';
import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';

// WHAT THIS FILE GUARDS
//
// The band is a claim about how much to trust a recommendation, so the tests
// have to fail when the claim stops matching the inputs, not merely when the
// wording changes. Every case below moves ONE real engine quantity (a start
// probability, a status flag, a source result, the discounted certainty of a
// later gameweek, the gap to the runner-up) and asserts both the band and the
// sentence that has to accompany it.
//
// The band must never render without a reason. That is asserted for every
// constructed case and again for the real sample dataset at the bottom.

const NOW = Date.parse('2026-11-27T12:00:00Z');
const FRESH = { fetchedAt: '2026-11-27T09:00:00Z', stale: false, staleReasonCodes: [], sources: [] };

// A deliberately boring world: eleven identical, fully fit, fully certain
// starters. Every case below perturbs exactly one thing about it, so a band
// change can only have come from that one thing.
function world({ players = {}, rows = {} } = {}) {
  const ids = Array.from({ length: 11 }, (_, i) => i + 1);
  const gsPlayers = new Map(ids.map(id => [id, {
    id, webName: `P${id}`, status: 'a', chanceNext: null, nowCost: 50, position: 3, teamId: 1,
    ...(players[id] || {}),
  }]));
  const byPlayer = new Map(ids.map(id => [id, [{
    playerId: id, gw: 13, xPoints: 5, sd: 3, ceiling: 10, pStart: 1, pAppear: 1, confidence: 'high',
    ...(rows[id] || {}),
  }]]));
  return {
    gameState: { players: gsPlayers, teams: new Map([[1, { id: 1, shortName: 'AAA' }]]) },
    projections: { gwFrom: 13, gwTo: 13, byPlayer },
    ids,
  };
}

function planOf(extra = {}) {
  const startingXI = Array.from({ length: 11 }, (_, i) => i + 1);
  return {
    gw: 13,
    horizon: 3,
    certainty: 'current',
    confidence: 1,
    startingXI,
    squad: startingXI.concat([12, 13, 14, 15]),
    transfersIn: [],
    transfersOut: [],
    transferCount: 0,
    alternatives: [],
    explanation: { transferReasons: [] },
    ...extra,
  };
}

const assess = (plan, w, opts = {}) => assessConfidence({
  plan, projections: w.projections, gameState: w.gameState, dataStatus: FRESH, now: NOW, ...opts,
});

/* ------------------------------------------------------------- the contract */

test('a band always arrives with a reason, and the reason names the band', () => {
  const w = world();
  const out = assess(planOf(), w);
  assert.equal(out.band, 'high');
  assert.equal(out.label, BAND_LABELS.high);
  assert.ok(out.reason.startsWith('High confidence, because '), out.reason);
  assert.ok(out.reason.length > 40, 'a band with no stated reason is worse than no band');
  assert.equal(out.factors.length, 5, 'all five inputs are reported, scoring or not');
  assert.ok(out.factors.every(f => typeof f.text === 'string' || f.text === null));
});

test('the band is a pure function of its inputs', () => {
  const w = world();
  const a = assess(planOf(), w);
  const b = assess(planOf(), w);
  assert.deepEqual(a, b);
});

test('a perfectly clear plan states what is right, not merely the absence of what is wrong', () => {
  const w = world();
  const out = assess(planOf(), w);
  assert.equal(out.score, 0);
  assert.deepEqual(out.drivers, []);
  assert.match(out.reason, /nobody in this eleven is injured, suspended or carrying a doubt/);
  assert.match(out.reason, /every player in this eleven has settled minutes/);
});

/* ------------------------------------------------------------------ minutes */

test('unclear minutes are weighed by the points that sit on them, not by the head count', () => {
  const w = world();
  // One starter of eleven, but he carries a big share of the eleven's points.
  const heavy = world({ rows: { 1: { xPoints: 30, pStart: 0.4 } } });
  const light = world({ rows: { 1: { xPoints: 1, pStart: 0.4 } } });

  const heavyOut = assess(planOf(), heavy);
  const lightOut = assess(planOf(), light);
  const clean = assess(planOf(), w);

  const shareOf = (out) => out.factors.find(f => f.key === 'minutes');
  assert.equal(shareOf(clean).weight, 0);
  assert.equal(shareOf(lightOut).weight, 0, 'one cheap rotation risk does not move the band');
  assert.equal(shareOf(heavyOut).weight, 2);
  assert.ok(shareOf(heavyOut).value > CONFIDENCE_PARAMS.unclearShareBad);
  assert.match(heavyOut.reason, /of this gameweek's projected points sits on players whose minutes are unclear/);
});

test('the minutes model saying "low" counts even when the start probability is high', () => {
  const three = world({ rows: { 1: { confidence: 'low' }, 2: { confidence: 'low' }, 3: { confidence: 'low' } } });
  const four = world({ rows: { 1: { confidence: 'low' }, 2: { confidence: 'low' }, 3: { confidence: 'low' }, 4: { confidence: 'low' } } });

  const a = assess(planOf(), three).factors.find(f => f.key === 'minutes');
  const b = assess(planOf(), four).factors.find(f => f.key === 'minutes');
  assert.equal(Math.round(a.value * 100), 27, '3 of 11 equal projections is a 27% share');
  assert.equal(a.weight, 1);
  assert.equal(Math.round(b.value * 100), 36);
  assert.equal(b.weight, 2, 'past 30% of the eleven\'s points, unclear minutes are the headline problem');
});

test('the unclear-minutes threshold is a start probability, not a guess', () => {
  const just = CONFIDENCE_PARAMS.unclearStartProbability;
  const above = world({ rows: { 1: { pStart: just }, 2: { pStart: just }, 3: { pStart: just }, 4: { pStart: just } } });
  const below = world({ rows: { 1: { pStart: just - 0.01 }, 2: { pStart: just - 0.01 }, 3: { pStart: just - 0.01 }, 4: { pStart: just - 0.01 } } });
  assert.equal(assess(planOf(), above).factors.find(f => f.key === 'minutes').weight, 0);
  assert.equal(assess(planOf(), below).factors.find(f => f.key === 'minutes').weight, 2);
});

/* ------------------------------------------------------------- availability */

test('an injury flag on a player the plan fields drops the band and names him', () => {
  const w = world({ players: { 4: { status: 'i', webName: 'Garner' } } });
  const out = assess(planOf(), w);
  assert.equal(out.band, 'moderate');
  assert.ok(out.drivers.includes('availability'));
  assert.match(out.reason, /Garner/);
  assert.match(out.reason, /injured, suspended or out of the squad/);
});

test('a flag on a player the plan is BUYING counts, because the plan commits to him', () => {
  const w = world({ players: { 12: { status: 's', webName: 'Rice' } } });
  w.gameState.players.set(12, { id: 12, webName: 'Rice', status: 's', chanceNext: null, nowCost: 50, position: 3, teamId: 1 });
  const out = assess(planOf({ transfersIn: [12], transfersOut: [11], transferCount: 1 }), w);
  assert.ok(out.drivers.includes('availability'));
  assert.match(out.reason, /Rice/);
});

test('one published doubt is a smaller mark than an injury, two are the same', () => {
  const one = world({ players: { 4: { status: 'd', chanceNext: 0.5, webName: 'Saka' } } });
  const two = world({ players: { 4: { status: 'd', chanceNext: 0.5 }, 5: { status: 'd', chanceNext: 0.75 } } });
  const oneOut = assess(planOf(), one);
  const twoOut = assess(planOf(), two);
  assert.equal(oneOut.factors.find(f => f.key === 'availability').weight, 1);
  assert.equal(twoOut.factors.find(f => f.key === 'availability').weight, 2);
  assert.match(oneOut.reason, /carries a fitness doubt \(Saka\)/);
  assert.match(twoOut.reason, /carry a fitness doubt/);
});

test('a chance of playing below 100 is a doubt even without the "d" status', () => {
  const w = world({ players: { 4: { status: 'a', chanceNext: 0.75 } } });
  assert.equal(assess(planOf(), w).factors.find(f => f.key === 'availability').weight, 1);
});

test('a flag on a benched player the plan does not field is not held against it', () => {
  const w = world();
  w.gameState.players.set(14, { id: 14, webName: 'Bench', status: 'i', chanceNext: 0, nowCost: 40, position: 3, teamId: 1 });
  const out = assess(planOf(), w);
  assert.equal(out.factors.find(f => f.key === 'availability').weight, 0);
});

/* -------------------------------------------------------------------- reach */

test('a projection for a later gameweek can never reach the top band', () => {
  const w = world();
  const next = assess(planOf({ certainty: 'projected', confidence: 0.85 }), w);
  const far = assess(planOf({ certainty: 'projected', confidence: 0.61 }), w);
  const distant = assess(planOf({ certainty: 'projected', confidence: 0.44 }), w);

  assert.equal(next.band, 'moderate');
  assert.equal(far.band, 'moderate');
  assert.equal(distant.band, 'low', 'far enough out, the claim is a guess and says so');
  assert.ok(next.score < far.score && far.score < distant.score, 'further out is never firmer');
  assert.match(next.reason, /projection for a later gameweek, which the planner discounts to 85% of this week's certainty/);
});

test('this gameweek is firmer than the same plan one gameweek out', () => {
  const w = world();
  const now = assess(planOf(), w);
  const later = assess(planOf({ certainty: 'projected', confidence: 0.85 }), w);
  assert.ok(now.score < later.score);
  assert.equal(now.band, 'high');
  assert.equal(later.band, 'moderate');
  assert.match(now.factors.find(f => f.key === 'reach').text, /this is the plan for this week's deadline, not a projection/);
});

test('a transfer that loses points this week and only pays later is marked as reaching forward', () => {
  const w = world();
  const paysLater = planOf({
    transferCount: 1, transfersIn: [12], transfersOut: [11],
    explanation: { transferReasons: [{ out: 11, in: 12, gwGain: -0.8, horizonGain: 4.2 }] },
  });
  const out = assess(paysLater, w);
  const reach = out.factors.find(f => f.key === 'reach');
  assert.equal(reach.weight, 1);
  assert.match(out.reason, /gives up 0.8 points this gameweek and only pays back over the gameweeks after it/);

  const paysNow = planOf({
    transferCount: 1, transfersIn: [12], transfersOut: [11],
    explanation: { transferReasons: [{ out: 11, in: 12, gwGain: 1.4, horizonGain: 4.2 }] },
  });
  assert.equal(assess(paysNow, w).factors.find(f => f.key === 'reach').weight, 0);
});

/* --------------------------------------------------------------------- data */

test('a source that failed outweighs a source that is merely old', () => {
  const w = world();
  const failed = assess(planOf(), w, { sources: [{ name: 'Your squad', ok: false, stale: false }] });
  const stale = assess(planOf(), w, {
    dataStatus: { ...FRESH, stale: true, staleReasonCodes: ['data_age'], fetchedAt: '2026-11-26T12:00:00Z' },
  });
  assert.equal(failed.factors.find(f => f.key === 'data').weight, 2);
  assert.equal(stale.factors.find(f => f.key === 'data').weight, 1);
  assert.match(failed.reason, /could not be loaded \(Your squad\)/);
  assert.match(stale.reason, /is 24 hours old/);
});

test('fresh, complete data is stated as a reason rather than left silent', () => {
  const out = assess(planOf(), world());
  const data = out.factors.find(f => f.key === 'data');
  assert.equal(data.weight, 0);
  assert.match(data.text, /up to date/);
});

/* ------------------------------------------------------------------- margin */

test('a runner-up inside the swing on the players they disagree about is called close', () => {
  const w = world();
  w.gameState.players.set(12, { id: 12, webName: 'In', status: 'a', chanceNext: null, nowCost: 50, position: 3, teamId: 1 });
  w.gameState.players.set(16, { id: 16, webName: 'Other', status: 'a', chanceNext: null, nowCost: 50, position: 3, teamId: 1 });
  w.projections.byPlayer.set(12, [{ playerId: 12, gw: 13, xPoints: 5, sd: 3, pStart: 1, confidence: 'high' }]);
  w.projections.byPlayer.set(16, [{ playerId: 16, gw: 13, xPoints: 5, sd: 3, pStart: 1, confidence: 'high' }]);

  // The two plans differ over one player each, so the swing is sqrt(3^2 + 3^2)
  // = 4.24 and the close-call threshold sits at 1.06 points.
  const base = { transferCount: 1, transfersIn: [12], transfersOut: [11] };
  const close = assess(planOf({ ...base, alternatives: [{ transfersIn: [16], transfersOut: [11], deltaHorizon: -0.4 }] }), w);
  const clear = assess(planOf({ ...base, alternatives: [{ transfersIn: [16], transfersOut: [11], deltaHorizon: -6.5 }] }), w);

  assert.equal(close.factors.find(f => f.key === 'margin').weight, 1);
  assert.equal(clear.factors.find(f => f.key === 'margin').weight, 0);
  assert.match(close.reason, /only 0.4 points behind/);
  assert.match(clear.factors.find(f => f.key === 'margin').text, /beats the next best by 6.5 points/);
});

test('an exact tie says the two plans are the same rather than printing 0.0 behind', () => {
  const w = world();
  w.gameState.players.set(12, { id: 12, webName: 'In', status: 'a', chanceNext: null, nowCost: 50, position: 3, teamId: 1 });
  w.gameState.players.set(16, { id: 16, webName: 'Other', status: 'a', chanceNext: null, nowCost: 50, position: 3, teamId: 1 });
  w.projections.byPlayer.set(12, [{ playerId: 12, gw: 13, xPoints: 5, sd: 3, pStart: 1, confidence: 'high' }]);
  w.projections.byPlayer.set(16, [{ playerId: 16, gw: 13, xPoints: 5, sd: 3, pStart: 1, confidence: 'high' }]);
  const out = assess(planOf({
    transferCount: 1, transfersIn: [12], transfersOut: [11],
    alternatives: [{ transfersIn: [16], transfersOut: [11], deltaHorizon: -0.001 }],
  }), w);
  assert.match(out.reason, /projects the same points over the horizon/);
  assert.doesNotMatch(out.reason, /0\.0 points behind/);
});

test('a close margin alone can qualify a plan but never demote it below high', () => {
  const w = world();
  w.gameState.players.set(12, { id: 12, webName: 'In', status: 'a', chanceNext: null, nowCost: 50, position: 3, teamId: 1 });
  w.projections.byPlayer.set(12, [{ playerId: 12, gw: 13, xPoints: 5, sd: 3, pStart: 1, confidence: 'high' }]);
  const out = assess(planOf({
    transferCount: 1, transfersIn: [12], transfersOut: [11],
    alternatives: [{ transfersIn: [], transfersOut: [], deltaHorizon: -0.2 }],
  }), w);
  assert.equal(out.band, 'high');
  assert.equal(out.score, 1);
  // The caveat is still stated, so a HIGH never hides what scored against it.
  assert.match(out.reason, /, though /);
});

test('no alternatives means no margin claim, in either direction', () => {
  const out = assess(planOf({ alternatives: [] }), world());
  const margin = out.factors.find(f => f.key === 'margin');
  assert.equal(margin.weight, 0);
  assert.equal(margin.text, null, 'a claim nothing supports is not made');
});

/* ------------------------------------------------------------- band arithmetic */

test('the bands stack: two independent problems are worse than one', () => {
  const clean = world();
  const one = world({ players: { 4: { status: 'i', webName: 'Garner' } } });
  const two = world({
    players: { 4: { status: 'i', webName: 'Garner' } },
    rows: { 1: { confidence: 'low' }, 2: { confidence: 'low' }, 3: { confidence: 'low' }, 5: { confidence: 'low' } },
  });

  assert.equal(assess(planOf(), clean).band, 'high');
  assert.equal(assess(planOf(), one).band, 'moderate');
  assert.equal(assess(planOf(), two).band, 'low');
});

test('a low band still leads with the two things that cost it most', () => {
  const w = world({
    players: { 4: { status: 'i', webName: 'Garner' } },
    rows: { 1: { confidence: 'low' }, 2: { confidence: 'low' }, 3: { confidence: 'low' }, 5: { confidence: 'low' } },
  });
  const out = assess(planOf(), w, { sources: [{ name: 'Fixtures', ok: false }] });
  assert.equal(out.band, 'low');
  assert.match(out.reason, /^Low confidence, because /);
  assert.match(out.reason, /Garner/);
  assert.equal(out.reason.split(' and ').length - 1 <= 3, true, 'the sentence stays a sentence');
});

/* ------------------------------------------------- against the real dataset */

const here = dirname(fileURLToPath(import.meta.url));
const readSample = (name) => JSON.parse(readFileSync(join(here, '..', 'data', 'sample', `${name}.json`), 'utf8'));

test('the committed sample plan gets a band and a reason built from its own numbers', async () => {
  const files = Object.fromEntries(
    ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks']
      .map(name => [name, readSample(name)]),
  );
  const bundle = assembleSampleBundle(files);
  const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  const squadState = buildSquadState({
    entry: bundle.entry, history: bundle.history, transfers: bundle.transfers,
    picks: bundle.picks, gameState, gw: bundle.planEvent,
  });
  const out = await buildPlan({ gameState, squadState, options: { risk: 'balanced', seed: 7, sample: true } });

  const now = Date.parse(bundle.fetchedAt) + 3600000;
  const current = assessConfidence({
    plan: out.current, projections: out.projections, gameState, dataStatus: out.dataStatus, now,
  });
  assert.ok(['high', 'moderate', 'low'].includes(current.band));
  assert.ok(current.reason.startsWith(`${BAND_LABELS[current.band]}, because `));
  // The plan sells the one injured player in the squad and fields nobody
  // flagged, so availability must not be one of the things holding it back.
  assert.ok(!current.drivers.includes('availability'), current.reason);

  // Every future gameweek is a projection, so none of them may claim the top
  // band, and each has to get further from certain as it gets further away.
  let previousScore = current.score;
  for (const future of out.future) {
    const band = assessConfidence({ plan: future, projections: out.projections, gameState, dataStatus: out.dataStatus, now });
    assert.notEqual(band.band, 'high', `GW${future.gw} is a projection and cannot be high confidence`);
    assert.ok(band.score >= previousScore, `GW${future.gw} must not be firmer than the gameweek before it`);
    assert.ok(band.reason.includes('projection for a later gameweek'));
    previousScore = band.score;
  }
});
