import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFeatureRows,
  featureVector,
  FEATURE_NAMES,
  SAME_GW_ALLOWED_COLUMNS,
  parseCsv,
  playerKeyFor,
} from '../scripts/train-model.mjs';
import { underlyingRates } from '../js/engine/projections.js';
import { buildStrength } from '../js/engine/strength.js';

// A structural leakage test, not a comment claiming there is no leakage.
//
// Every row handed to the feature builder is wrapped in a Proxy that records
// which column of which gameweek was read. Afterwards we assert:
//
//   1. no column of a FUTURE gameweek was touched at all,
//   2. the only columns of the gameweek being PREDICTED that were touched are
//      the ones fixed before its deadline (fixture, opponent, home or away,
//      price, position), and
//   3. the builder actually read something, so a builder that silently returned
//      constants could not pass.

const COLUMNS = [
  'name', 'position', 'team', 'xP', 'assists', 'bonus', 'bps', 'clean_sheets', 'creativity',
  'element', 'expected_assists', 'expected_goal_involvements', 'expected_goals',
  'expected_goals_conceded', 'fixture', 'goals_conceded', 'goals_scored', 'ict_index',
  'influence', 'kickoff_time', 'minutes', 'opponent_team', 'own_goals', 'penalties_missed',
  'penalties_saved', 'red_cards', 'round', 'saves', 'selected', 'starts', 'team_a_score',
  'team_h_score', 'threat', 'total_points', 'transfers_balance', 'transfers_in',
  'transfers_out', 'value', 'was_home', 'yellow_cards', 'GW',
];

// Columns that describe what HAPPENED in a gameweek. Reading any of these from
// the gameweek being predicted is leakage by definition.
const OUTCOME_COLUMNS = COLUMNS.filter(c => !SAME_GW_ALLOWED_COLUMNS.includes(c));

function makeRow(over) {
  const row = {};
  for (const c of COLUMNS) row[c] = '0';
  row.name = 'Player One';
  row.position = 'MID';
  row.team = 'Arsenal';
  row.was_home = 'True';
  row.kickoff_time = '2024-08-17T14:00:00Z';
  return Object.assign(row, over);
}

// A believable season for two players at two clubs, so the club aggregates and
// the opponent features have something to read.
function makeSeasonRows(gws = 12) {
  const rows = [];
  for (let gw = 1; gw <= gws; gw++) {
    for (const [element, team, opponent] of [['1', 'Arsenal', '2'], ['2', 'Chelsea', '1']]) {
      rows.push(makeRow({
        element,
        team,
        opponent_team: opponent,
        GW: String(gw),
        round: String(gw),
        fixture: String(gw * 10 + Number(element)),
        minutes: '90',
        starts: '1',
        total_points: String(2 + (gw % 5)),
        bps: String(20 + gw),
        expected_goals: '0.20',
        expected_assists: '0.15',
        expected_goals_conceded: '1.10',
        saves: '0',
        value: String(70 + gw),
        was_home: element === '1' ? 'True' : 'False',
        team_h_score: '2',
        team_a_score: '1',
      }));
    }
  }
  return rows;
}

function watch(rows) {
  const reads = [];
  const proxied = rows.map(row => new Proxy(row, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) {
        reads.push({ gw: Number(target.GW), column: prop });
      }
      return target[prop];
    },
  }));
  return { proxied, reads, reset: () => { reads.length = 0; } };
}

test('featureVector reads no same-gameweek or future-gameweek outcome, at every gameweek', () => {
  const rows = makeSeasonRows(12);
  const { proxied, reads, reset } = watch(rows);
  const playerRows = proxied.filter(r => r.element === '1');
  // Club aggregates come from an unwatched copy of the same data. They are held
  // to the same rule by their own `before(team, gw)` accessor, which the
  // poisoning tests below prove independently.
  const teamHistory = { before: () => ({ matches: 3, scored: 4, conceded: 3 }) };

  let totalReads = 0;
  for (let i = 1; i < playerRows.length; i++) {
    const target = playerRows[i];
    const targetGw = Number(rows.filter(r => r.element === '1')[i].GW);
    reset();
    const v = featureVector(playerRows.slice(0, i), target, teamHistory);
    assert.equal(v.length, FEATURE_NAMES.length);
    totalReads += reads.length;

    for (const r of reads) {
      if (r.gw < targetGw) continue;
      assert.ok(
        r.gw === targetGw,
        `read gameweek ${r.gw} while building features for gameweek ${targetGw}`,
      );
      assert.ok(
        SAME_GW_ALLOWED_COLUMNS.includes(r.column),
        `read the outcome column "${r.column}" from gameweek ${targetGw}, the gameweek being predicted`,
      );
    }
  }

  // Positive control: a builder that read nothing would pass every assertion
  // above, so assert that it really did read the data.
  assert.ok(totalReads > 200, `expected real property access, saw ${totalReads}`);
});

test('buildFeatureRows reads only pre-deadline columns from the final gameweek it targets', () => {
  const rows = makeSeasonRows(12);
  const { proxied, reads } = watch(rows);
  const built = buildFeatureRows(proxied, { season: '2024-25', teamHistoryRows: rows });
  assert.ok(built.length > 0, 'the builder must produce rows');

  // The labels themselves are read from the target row, which is what a label
  // is. They are named here so that any OTHER outcome column showing up fails
  // the test, and the poisoning test above proves they never reach `features`.
  const LABEL_COLUMNS = ['total_points', 'starts', 'minutes'];

  const maxGw = Math.max(...built.map(b => b.gw));
  const atMax = reads.filter(r => r.gw === maxGw);
  assert.ok(atMax.length > 0, 'the target gameweek row must be read for its fixture and price');
  for (const r of atMax) {
    assert.ok(
      SAME_GW_ALLOWED_COLUMNS.includes(r.column) || LABEL_COLUMNS.includes(r.column),
      `feature builder read the outcome column "${r.column}" from the last gameweek it predicts`,
    );
  }
  for (const c of LABEL_COLUMNS) {
    assert.ok(atMax.some(r => r.column === c), `the label "${c}" should be read from the target row`);
  }
  assert.equal(reads.filter(r => r.gw > maxGw).length, 0, 'no gameweek beyond the last target exists to read');
});

test('poisoning the outcome columns of the target gameweek changes nothing', () => {
  const rows = makeSeasonRows(10);
  const clean = buildFeatureRows(rows.map(r => ({ ...r })), { season: 's' });

  const poisoned = rows.map(r => {
    const copy = { ...r };
    if (Number(copy.GW) >= 6) {
      for (const c of OUTCOME_COLUMNS) copy[c] = '999999';
    }
    return copy;
  });
  const after = buildFeatureRows(poisoned, { season: 's' });

  const cleanAtSix = clean.filter(r => r.gw === 6);
  const afterAtSix = after.filter(r => r.gw === 6);
  assert.ok(cleanAtSix.length > 0);
  assert.equal(cleanAtSix.length, afterAtSix.length);
  for (let i = 0; i < cleanAtSix.length; i++) {
    assert.deepEqual(
      afterAtSix[i].features,
      cleanAtSix[i].features,
      'features for gameweek 6 must not move when gameweek 6 and later outcomes are poisoned',
    );
    assert.equal(afterAtSix[i].baselinePoints, cleanAtSix[i].baselinePoints);
  }
});

test('poisoning a PAST gameweek does change the features, proving the builder reads them', () => {
  // The counterpart to the test above. Without this, a builder that ignored all
  // history would pass the leakage checks trivially.
  const rows = makeSeasonRows(10);
  const clean = buildFeatureRows(rows.map(r => ({ ...r })), { season: 's' });
  const poisoned = buildFeatureRows(
    rows.map(r => (Number(r.GW) === 4 ? { ...r, expected_goals: '9.5', total_points: '25' } : { ...r })),
    { season: 's' },
  );
  const a = clean.find(r => r.gw === 6 && r.playerKey === playerKeyFor('s', '1'));
  const b = poisoned.find(r => r.gw === 6 && r.playerKey === playerKeyFor('s', '1'));
  assert.notDeepEqual(b.features, a.features);
  assert.ok(b.baselinePoints > a.baselinePoints);
});

test('every declared feature name maps to exactly one slot in the vector', () => {
  const rows = makeSeasonRows(8);
  const built = buildFeatureRows(rows, { season: 's' });
  assert.equal(built[0].features.length, FEATURE_NAMES.length);
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length, 'feature names must be unique');
  for (const v of built[0].features) assert.ok(Number.isFinite(v), 'features must all be finite');
});

test('featureVector with no prior gameweeks still produces a finite vector', () => {
  const target = makeRow({ element: '1', team: 'Arsenal', opponent_team: '2', GW: '1', value: '55' });
  const v = featureVector([], target, { before: () => ({ matches: 0, scored: 0, conceded: 0 }) });
  assert.equal(v.length, FEATURE_NAMES.length);
  for (const x of v) assert.ok(Number.isFinite(x));
  assert.equal(v[FEATURE_NAMES.indexOf('isMid')], 1);
  assert.equal(v[FEATURE_NAMES.indexOf('wasHome')], 1);
  assert.equal(v[FEATURE_NAMES.indexOf('priceMillions')], 5.5);
});

test('the same-gameweek allowlist contains no outcome column', () => {
  const outcomeish = [
    'minutes', 'total_points', 'goals_scored', 'assists', 'bonus', 'bps', 'clean_sheets',
    'goals_conceded', 'saves', 'starts', 'expected_goals', 'expected_assists',
    'expected_goals_conceded', 'team_h_score', 'team_a_score', 'yellow_cards', 'red_cards',
    'own_goals', 'penalties_saved', 'penalties_missed', 'influence', 'creativity', 'threat',
    'ict_index', 'xP', 'selected', 'transfers_in', 'transfers_out', 'transfers_balance',
  ];
  for (const c of outcomeish) {
    assert.ok(!SAME_GW_ALLOWED_COLUMNS.includes(c), `"${c}" must never be readable from the target gameweek`);
  }
});

// --- the same rule inside the browser engine -------------------------------

test('the strength model reads no fixture from the gameweek it is projecting', () => {
  const teams = new Map();
  const players = new Map();
  for (let t = 1; t <= 4; t++) {
    teams.set(t, { id: t, strengthOverallHome: 3, strengthOverallAway: 3 });
    for (let i = 0; i < 5; i++) {
      players.set(t * 100 + i, { id: t * 100 + i, teamId: t, position: (i % 4) + 1, minutes: 3000, xG: 2, xGC: 40 });
    }
  }
  const fixtures = [];
  for (let gw = 1; gw <= 6; gw++) {
    fixtures.push({
      id: gw, event: gw, teamH: 1, teamA: 2, teamHScore: 5, teamAScore: 0,
      finished: true, started: true, teamHDifficulty: 3, teamADifficulty: 3, kickoff: null,
    });
  }
  const gameState = { rules: { starters: 11, totalEvents: 38 }, teams, players, fixtures, events: [], nextEvent: 4 };

  const planningGw4 = buildStrength(gameState, { asOfGw: 4 });
  const planningGw5 = buildStrength(gameState, { asOfGw: 5 });
  assert.equal(planningGw4.matchesUsed, 3, 'gameweeks 4, 5 and 6 must be invisible when planning gameweek 4');
  assert.equal(planningGw5.matchesUsed, 4);
});

test('underlying player rates read no gameweek at or after the one being projected', () => {
  const history = [];
  for (let gw = 1; gw <= 8; gw++) {
    history.push({ gw, minutes: 90, xG: gw >= 5 ? 5 : 0.1, xA: 0, bps: 20, cbit: 1, recoveries: 1, tackles: 1 });
  }
  const player = { id: 1, position: 4, minutes: 720, xG: 20.4, xA: 0, bps: 160, saves: 0, cbit: 8, recoveries: 8, tackles: 8, yellowCards: 0, redCards: 0, penaltiesSaved: 0, history };
  const atGw5 = underlyingRates(player, { gw: 5 });
  const atGw9 = underlyingRates(player, { gw: 9 });
  assert.ok(atGw5.xG < 0.2, `gameweeks 5 onward must be invisible at gameweek 5, got ${atGw5.xG}`);
  assert.ok(atGw9.xG > 2, 'and visible once they are in the past');
});

test('the CSV parser survives quoted fields and a trailing newline', () => {
  const { header, rows } = parseCsv('a,b\n1,"x,y"\n2,"he said ""hi"""\n');
  assert.deepEqual(header, ['a', 'b']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].b, 'x,y');
  assert.equal(rows[1].b, 'he said "hi"');
});
