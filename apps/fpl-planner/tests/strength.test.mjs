import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStrength, ratingFor, aggregateSquadXg, STRENGTH_PARAMS } from '../js/engine/strength.js';

// A structurally faithful stand-in for the live payload: 20 clubs, 17 with a
// full season of Premier League minutes behind them and 3 promoted sides whose
// squads have essentially none. That 17/3 split is the actual pre-season state
// and is what the promoted prior exists for.
const TEAM_SHAPES = [
  { id: 1, xg: 1.95, xgc: 0.95, overallH: 4, overallA: 5 },
  { id: 2, xg: 1.85, xgc: 1.05, overallH: 4, overallA: 4 },
  { id: 3, xg: 1.75, xgc: 1.10, overallH: 4, overallA: 5 },
  { id: 4, xg: 1.70, xgc: 1.20, overallH: 4, overallA: 4 },
  { id: 5, xg: 1.65, xgc: 1.25, overallH: 3, overallA: 4 },
  { id: 6, xg: 1.60, xgc: 1.30, overallH: 3, overallA: 3 },
  { id: 7, xg: 1.55, xgc: 1.35, overallH: 3, overallA: 3 },
  { id: 8, xg: 1.50, xgc: 1.40, overallH: 3, overallA: 3 },
  { id: 9, xg: 1.45, xgc: 1.45, overallH: 3, overallA: 3 },
  { id: 10, xg: 1.40, xgc: 1.45, overallH: 3, overallA: 3 },
  { id: 11, xg: 1.35, xgc: 1.50, overallH: 3, overallA: 3 },
  { id: 12, xg: 1.30, xgc: 1.55, overallH: 2, overallA: 3 },
  { id: 13, xg: 1.25, xgc: 1.60, overallH: 2, overallA: 3 },
  { id: 14, xg: 1.20, xgc: 1.65, overallH: 2, overallA: 3 },
  { id: 15, xg: 1.15, xgc: 1.70, overallH: 2, overallA: 3 },
  { id: 16, xg: 1.10, xgc: 1.75, overallH: 2, overallA: 3 },
  { id: 17, xg: 0.95, xgc: 1.85, overallH: 2, overallA: 3 },
  // Promoted: no Premier League minutes at all, lowest published strength.
  { id: 18, xg: 0, xgc: 0, overallH: 2, overallA: 2, minutes: 0 },
  { id: 19, xg: 0, xgc: 0, overallH: 2, overallA: 2, minutes: 88 },
  { id: 20, xg: 0, xgc: 0, overallH: 2, overallA: 2, minutes: 2542 },
];

const FULL_SEASON_MINUTES = 38 * 11 * 90; // 37620 squad minutes for a whole season

function makeGameState({ fixtures = [], nextEvent = 1, shapes = TEAM_SHAPES } = {}) {
  const teams = new Map();
  const players = new Map();
  let pid = 1;
  for (const s of shapes) {
    teams.set(s.id, {
      id: s.id,
      code: s.id,
      name: `Team ${s.id}`,
      shortName: `T${s.id}`,
      strengthOverallHome: s.overallH,
      strengthOverallAway: s.overallA,
    });
    const minutes = s.minutes === undefined ? FULL_SEASON_MINUTES : s.minutes;
    // Spread the club total over 20 players so the aggregation has something
    // realistic to sum, and give each the club's per-90 conceding rate.
    const share = minutes / 20;
    const matches = minutes / (11 * 90);
    for (let i = 0; i < 20; i++) {
      players.set(pid, {
        id: pid,
        teamId: s.id,
        position: (i % 4) + 1,
        minutes: share,
        xG: (s.xg * matches) / 20,
        xGC: (s.xgc * share) / 90,
      });
      pid++;
    }
  }
  return {
    rules: { starters: 11, totalEvents: 38 },
    teams,
    players,
    fixtures,
    events: [],
    nextEvent,
    currentEvent: null,
    seasonStarted: fixtures.some(f => f.finished),
  };
}

function fixture(id, event, teamH, teamA, hs = null, as_ = null) {
  return {
    id,
    event,
    teamH,
    teamA,
    teamHScore: hs,
    teamAScore: as_,
    finished: hs !== null,
    started: hs !== null,
    teamHDifficulty: 3,
    teamADifficulty: 3,
    kickoff: null,
  };
}

test('squad aggregation recovers the club xG and xGC per match it was built from', () => {
  const gs = makeGameState();
  const agg = aggregateSquadXg(gs);
  const a = agg.get(1);
  assert.ok(Math.abs(a.xgPerMatch - 1.95) < 1e-9, `xgPerMatch ${a.xgPerMatch}`);
  assert.ok(Math.abs(a.xgcPerMatch - 0.95) < 1e-9, `xgcPerMatch ${a.xgcPerMatch}`);
  assert.equal(agg.get(18).minutes, 0);
  assert.equal(agg.get(18).xgPerMatch, null);
});

test('pre-season ratings are centred on 1 and ordered by underlying quality', () => {
  const s = buildStrength(makeGameState(), { asOfGw: 1 });
  assert.equal(s.source, 'prior');
  assert.equal(s.matchesUsed, 0);

  const attacks = [...s.teams.values()].map(t => t.attack);
  const defences = [...s.teams.values()].map(t => t.defence);
  const geo = (v) => Math.exp(v.reduce((a, b) => a + Math.log(b), 0) / v.length);
  assert.ok(Math.abs(geo(attacks) - 1) < 1e-9, `attack geomean ${geo(attacks)}`);
  assert.ok(Math.abs(geo(defences) - 1) < 1e-9, `defence geomean ${geo(defences)}`);

  assert.ok(s.teams.get(1).attack > s.teams.get(17).attack);
  assert.ok(s.teams.get(1).defence < s.teams.get(17).defence);
});

test('promoted clubs are shrunk toward the promoted prior, not treated as average or as zero', () => {
  const s = buildStrength(makeGameState(), { asOfGw: 1 });
  for (const id of [18, 19, 20]) {
    const t = s.teams.get(id);
    assert.equal(t.promoted, true, `team ${id} should be flagged promoted`);
    assert.equal(t.confidence, 'low');
    assert.ok(t.attack > STRENGTH_PARAMS.ratingMin, `team ${id} attack collapsed to the floor`);
    assert.ok(t.attack < 0.95, `team ${id} attack ${t.attack} is too close to average`);
    assert.ok(t.defence > 1.05, `team ${id} defence ${t.defence} is too close to average`);
  }
  // Bottom quarter of the league at both ends, which is where a promoted side
  // belongs. Not necessarily last: an established club can be genuinely worse.
  const established = [...s.teams.values()].filter(t => !t.promoted);
  const attacks = established.map(t => t.attack).sort((a, b) => a - b);
  const defences = established.map(t => t.defence).sort((a, b) => a - b);
  const q25 = (arr) => arr[Math.floor(arr.length * 0.25)];
  const q75 = (arr) => arr[Math.floor(arr.length * 0.75)];
  assert.ok(s.teams.get(18).attack <= q25(attacks), `${s.teams.get(18).attack} vs q25 ${q25(attacks)}`);
  assert.ok(s.teams.get(18).defence >= q75(defences), `${s.teams.get(18).defence} vs q75 ${q75(defences)}`);
});

test('a promoted club with a handful of minutes is not driven by that tiny sample', () => {
  const s = buildStrength(makeGameState(), { asOfGw: 1 });
  const spread = Math.abs(s.teams.get(18).attack - s.teams.get(19).attack);
  assert.ok(spread < 0.05, `88 minutes moved the rating by ${spread}`);
});

test('home advantage falls back exactly to the prior when there are no results', () => {
  const s = buildStrength(makeGameState(), { asOfGw: 1 });
  assert.ok(Math.abs(s.homeAdvantage - STRENGTH_PARAMS.homeAdvantagePrior) < 1e-12);
});

test('ratings move as matches accumulate', () => {
  const prior = buildStrength(makeGameState(), { asOfGw: 1 });
  // Club 17 (weakest prior) wins five games heavily.
  const played = [];
  let id = 1;
  for (let gw = 1; gw <= 5; gw++) {
    played.push(fixture(id++, gw, 17, gw, 4, 0));
    played.push(fixture(id++, gw, 6, 7, 1, 1));
  }
  const fitted = buildStrength(makeGameState({ fixtures: played, nextEvent: 6 }), { asOfGw: 6 });
  assert.equal(fitted.source, 'fitted');
  assert.equal(fitted.matchesUsed, 10);
  assert.ok(
    fitted.teams.get(17).attack > prior.teams.get(17).attack,
    `attack should rise: ${prior.teams.get(17).attack} -> ${fitted.teams.get(17).attack}`,
  );
  assert.ok(fitted.teams.get(17).defence < prior.teams.get(17).defence);
  assert.equal(fitted.teams.get(17).matchesUsed, 5);
});

test('results from the gameweek being planned are never read (leakage guard)', () => {
  const played = [];
  let id = 1;
  for (let gw = 1; gw <= 5; gw++) played.push(fixture(id++, gw, 17, gw, 5, 0));
  const gs = makeGameState({ fixtures: played, nextEvent: 5 });

  const before = buildStrength(gs, { asOfGw: 5 });
  const after = buildStrength(gs, { asOfGw: 6 });
  assert.equal(before.matchesUsed, 4, 'gameweek 5 must be excluded when planning gameweek 5');
  assert.equal(after.matchesUsed, 5);
  assert.notEqual(before.teams.get(17).attack, after.teams.get(17).attack);
});

test('recency weighting makes an old result count less than a recent one', () => {
  const early = [fixture(1, 1, 17, 1, 6, 0)];
  const late = [fixture(1, 20, 17, 1, 6, 0)];
  const asOfGw = 21;
  const withEarly = buildStrength(makeGameState({ fixtures: early, nextEvent: asOfGw }), { asOfGw });
  const withLate = buildStrength(makeGameState({ fixtures: late, nextEvent: asOfGw }), { asOfGw });
  assert.ok(
    withLate.teams.get(17).attack > withEarly.teams.get(17).attack,
    'the recent blowout should move the rating further',
  );
});

test('caller-supplied team xG is used in place of goals when available', () => {
  const played = [fixture(1, 1, 17, 1, 0, 0)];
  const asOfGw = 2;
  const gs = makeGameState({ fixtures: played, nextEvent: asOfGw });
  const onGoals = buildStrength(gs, { asOfGw });
  const onXg = buildStrength(gs, { asOfGw, teamXg: new Map([[1, { home: 4.2, away: 0.2 }]]) });
  assert.ok(onXg.teams.get(17).attack > onGoals.teams.get(17).attack);
});

test('ratingFor exposes attack, defence and the home term, and rejects unknown clubs', () => {
  const s = buildStrength(makeGameState(), { asOfGw: 1 });
  const r = ratingFor(s, 1);
  assert.equal(r.attack, s.teams.get(1).attack);
  assert.equal(r.defence, s.teams.get(1).defence);
  assert.equal(r.homeAdv, s.homeAdvantage);
  assert.throws(() => ratingFor(s, 999), /unknown team/);
});

test('league mean goals stays in a sane range in both regimes', () => {
  const prior = buildStrength(makeGameState(), { asOfGw: 1 });
  assert.ok(prior.leagueMeanGoals > 1.0 && prior.leagueMeanGoals < 2.0, `${prior.leagueMeanGoals}`);
  const played = [];
  let id = 1;
  for (let gw = 1; gw <= 4; gw++) {
    for (let t = 1; t <= 19; t += 2) played.push(fixture(id++, gw, t, t + 1, 2, 1));
  }
  const fitted = buildStrength(makeGameState({ fixtures: played, nextEvent: 5 }), { asOfGw: 5 });
  assert.ok(fitted.leagueMeanGoals > 1.0 && fitted.leagueMeanGoals < 2.2, `${fitted.leagueMeanGoals}`);
});
