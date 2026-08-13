import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_COLUMNS,
  SEASON_SPECIFIC_COLUMNS,
  SEASON_HALF_LIFE_GRID,
  FEATURE_NAMES,
  missingColumns,
  normalizePosition,
  seasonWeights,
  rowWeights,
  buildFeatureRows,
  featureVector,
  splitRows,
  playerKeyFor,
} from '../scripts/train-model.mjs';
import { ridge } from '../js/engine/ml.js';

// REGIME SAFETY
//
// merged_gw.csv does not have one schema, it has one per season. 2024-25 added
// seven mng_* columns for assistant managers and dropped them again; 2025-26
// added defensive_contribution, tackles, recoveries and
// clearances_blocks_interceptions. An absent column parses to '' and Number('')
// coerces to 0, so a feature reading one of them would tell the model a player
// made zero tackles in three seasons where nobody counted tackles.
//
// "Zero" and "not recorded" are different claims and the model cannot tell them
// apart, so these tests make the difference structural rather than a promise.

const BASE_COLUMNS = [
  'element', 'name', 'position', 'team', 'GW', 'round', 'fixture', 'opponent_team',
  'was_home', 'kickoff_time', 'value', 'minutes', 'starts', 'expected_goals',
  'expected_assists', 'expected_goals_conceded', 'bps', 'saves', 'total_points',
  'team_h_score', 'team_a_score', 'goals_scored', 'assists', 'bonus', 'clean_sheets',
];

// Only in 2025-26 (defensive contribution) or only in 2024-25 (managers).
const SEASON_SPECIFIC_SAMPLE = {
  defensive_contribution: '2',
  tackles: '4',
  recoveries: '9',
  clearances_blocks_interceptions: '3',
  mng_win: '1',
  mng_draw: '0',
  mng_loss: '0',
  mng_clean_sheets: '1',
  mng_goals_scored: '2',
  mng_underdog_win: '1',
  mng_underdog_draw: '0',
  modified: 'False',
};

function makeRow(over) {
  const row = {};
  for (const c of BASE_COLUMNS) row[c] = '0';
  row.name = 'Player One';
  row.position = 'MID';
  row.team = 'Arsenal';
  row.was_home = 'True';
  row.kickoff_time = '2026-01-01T15:00:00Z';
  return Object.assign(row, over);
}

function makeSeason({ gws = 10, seasonSpecific = false, position = 'MID', extra = {} } = {}) {
  const rows = [];
  for (let gw = 1; gw <= gws; gw++) {
    for (const [element, team, opponent] of [['1', 'Arsenal', '2'], ['2', 'Chelsea', '1']]) {
      const row = makeRow({
        element,
        team,
        opponent_team: opponent,
        position: element === '1' ? position : 'DEF',
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
        value: String(70 + gw),
        was_home: element === '1' ? 'True' : 'False',
        team_h_score: '2',
        team_a_score: '1',
        ...extra,
      });
      if (seasonSpecific) Object.assign(row, SEASON_SPECIFIC_SAMPLE);
      rows.push(row);
    }
  }
  return rows;
}

test('no feature reads a column that only some seasons have', () => {
  const without = buildFeatureRows(makeSeason({ seasonSpecific: false }), { season: 'a' });
  const withThem = buildFeatureRows(makeSeason({ seasonSpecific: true }), { season: 'a' });

  assert.ok(without.length > 0);
  assert.equal(without.length, withThem.length);
  for (let i = 0; i < without.length; i++) {
    assert.deepEqual(
      withThem[i].features,
      without[i].features,
      'adding the 2025-26-only and 2024-25-only columns must not move a single feature',
    );
    assert.equal(withThem[i].targetPoints, without[i].targetPoints);
    assert.equal(withThem[i].baselinePoints, without[i].baselinePoints);
  }
});

test('the same comparison DOES move when a column the builder reads changes', () => {
  // Positive control. Without this the test above would pass for a builder that
  // read nothing at all, which is the usual way a "no leakage" test lies.
  const plain = buildFeatureRows(makeSeason(), { season: 'a' });
  const bumped = buildFeatureRows(makeSeason({ extra: { bps: '95' } }), { season: 'a' });
  assert.notDeepEqual(bumped[0].features, plain[0].features);
});

test('the required and season-specific column lists are disjoint', () => {
  for (const column of Object.keys(SEASON_SPECIFIC_COLUMNS)) {
    assert.ok(
      !REQUIRED_COLUMNS.includes(column),
      `"${column}" does not exist in every season, so nothing may require it`,
    );
  }
  assert.equal(new Set(REQUIRED_COLUMNS).size, REQUIRED_COLUMNS.length, 'required columns must be unique');
});

test('a season missing a column the builder reads is detected, not silently zeroed', () => {
  const full = REQUIRED_COLUMNS.slice();
  assert.deepEqual(missingColumns(full), []);
  assert.deepEqual(missingColumns([...full, 'defensive_contribution']), []);

  // 2021-22 and earlier: no expected goals, no expected assists, no starts.
  const preXg = full.filter(c => !['expected_goals', 'expected_assists', 'expected_goals_conceded', 'starts'].includes(c));
  assert.deepEqual(
    missingColumns(preXg).sort(),
    ['expected_assists', 'expected_goals', 'expected_goals_conceded', 'starts'],
    'the seasons before 2022-23 must be rejected by name, which is why the history starts there',
  );
  assert.deepEqual(missingColumns([]).sort(), REQUIRED_COLUMNS.slice().sort());
  assert.deepEqual(missingColumns(undefined).sort(), REQUIRED_COLUMNS.slice().sort());
});

test('an absent column would read as a real zero, which is what the guard exists to stop', () => {
  // The hazard itself, asserted rather than described: a row without `starts`
  // produces the same start rate as a row that recorded starts of 0. The model
  // cannot distinguish them, so the schema check has to.
  const missing = makeSeason().map(r => {
    const copy = { ...r };
    delete copy.starts;
    return copy;
  });
  const zeroed = makeSeason({ extra: { starts: '0' } });
  const a = buildFeatureRows(missing, { season: 'a' });
  const b = buildFeatureRows(zeroed, { season: 'a' });
  const startRate = FEATURE_NAMES.indexOf('startRate');
  assert.equal(a[0].features[startRate], b[0].features[startRate]);
  assert.equal(a[0].features[startRate], 0);
});

// --- positions ------------------------------------------------------------

test('goalkeepers are recognized, because the CSV writes GK and not GKP', () => {
  // v1 tested targetRow.position === 'GKP' against a column containing 'GK', so
  // isGkp was 0 on every row of every season and carried a weight of exactly 0
  // in every stored candidate. This is the regression test for that.
  assert.equal(normalizePosition('GK'), 'GKP');
  assert.equal(normalizePosition('GKP'), 'GKP');
  assert.equal(normalizePosition('gk'), 'GKP');
  assert.equal(normalizePosition(' Def '), 'DEF');

  const keeper = makeRow({ position: 'GK', element: '9', opponent_team: '2', GW: '5', value: '45' });
  const v = featureVector([], keeper, { before: () => ({ matches: 0, scored: 0, conceded: 0 }) });
  assert.equal(v[FEATURE_NAMES.indexOf('isGkp')], 1, 'a goalkeeper must set isGkp');
  assert.equal(v[FEATURE_NAMES.indexOf('isDef')], 0);

  const built = buildFeatureRows(makeSeason({ position: 'GK' }), { season: 'a' });
  assert.ok(built.some(r => r.position === 'GKP'), 'a keeper must survive into the dataset as GKP');
  assert.ok(
    built.filter(r => r.position === 'GKP').every(r => r.features[FEATURE_NAMES.indexOf('isGkp')] === 1),
    'isGkp must be a live feature, not a column of zeros',
  );
});

test('non-footballers are dropped instead of being modelled as zeroes', () => {
  // Assistant managers existed in 2024-25 only. They never record minutes or
  // starts, so every feature describing them is zero, and every point they
  // scored came from mng_* columns no other season has. In v1 they sat in the
  // held-out block where the carried-forward baseline could predict them and no
  // feature-based model could.
  assert.equal(normalizePosition('AM'), null);
  assert.equal(normalizePosition(''), null);
  assert.equal(normalizePosition(undefined), null);

  const rows = makeSeason();
  for (let gw = 1; gw <= 10; gw++) {
    rows.push(makeRow({
      element: '99', position: 'AM', team: 'Arsenal', opponent_team: '2',
      GW: String(gw), fixture: String(gw * 10 + 1), minutes: '0', starts: '0',
      total_points: '6', value: '15',
    }));
  }
  const built = buildFeatureRows(rows, { season: '2024-25' });
  assert.ok(built.length > 0);
  assert.ok(!built.some(r => r.playerKey === playerKeyFor('2024-25', '99')), 'an assistant manager must not become a training row');
  assert.ok(built.every(r => ['GKP', 'DEF', 'MID', 'FWD'].includes(r.position)));
});

// --- recency weighting ----------------------------------------------------

test('season weights halve every half-life, counted back from the newest season', () => {
  const seasons = ['2022-23', '2023-24', '2024-25', '2025-26'];

  const off = seasonWeights(seasons, null);
  assert.deepEqual([...off.values()], [1, 1, 1, 1], 'null means every row counts the same');

  const oneSeason = seasonWeights(seasons, 1);
  assert.equal(oneSeason.get('2025-26'), 1);
  assert.equal(oneSeason.get('2024-25'), 0.5);
  assert.equal(oneSeason.get('2023-24'), 0.25);
  assert.equal(oneSeason.get('2022-23'), 0.125);

  const twoSeasons = seasonWeights(seasons, 2);
  assert.equal(twoSeasons.get('2025-26'), 1);
  assert.ok(Math.abs(twoSeasons.get('2023-24') - 0.5) < 1e-12, 'two seasons old at a half-life of 2 is exactly half');

  // Monotone in age for every half-life on the grid, which is the whole point.
  for (const halfLife of SEASON_HALF_LIFE_GRID.filter(h => h !== null)) {
    const w = seasonWeights(seasons, halfLife);
    for (let i = 1; i < seasons.length; i++) {
      assert.ok(w.get(seasons[i]) > w.get(seasons[i - 1]), `half-life ${halfLife}: newer seasons must weigh more`);
    }
  }
});

test('row weights reach the fit and actually change it', () => {
  const seasons = ['2023-24', '2024-25'];
  const rows = [
    { season: '2023-24', features: [0] },
    { season: '2024-25', features: [1] },
  ];
  assert.equal(rowWeights(rows, seasons, null), null, 'weighting off must pass no weights at all');
  assert.deepEqual(rowWeights(rows, seasons, 1), [0.5, 1]);

  // A fit that ignored the weights would return the same coefficients, so this
  // is what stops the parameter from being a knob wired to nothing.
  const X = [[0], [0], [1], [1]];
  const y = [0, 0, 10, 0];
  const unweighted = ridge(X, y, 1e-9);
  const weighted = ridge(X, y, 1e-9, { sampleWeights: [1, 1, 8, 1] });
  assert.ok(
    Math.abs(weighted.weights[0] - unweighted.weights[0]) > 1e-3,
    'sample weights must move the coefficients',
  );
});

// --- the ablation split ---------------------------------------------------

test('dropping the newest season from training leaves the evaluation blocks untouched', () => {
  // The ablation only means anything if every arm is scored on identical rows.
  const seasons = ['2024-25', '2025-26'];
  const rows = [];
  for (const season of seasons) {
    for (let gw = 5; gw <= 38; gw++) rows.push({ season, gw, features: [gw] });
  }
  const withNewest = splitRows(rows, seasons);
  const withoutNewest = splitRows(rows, seasons, { evalSeasonInTrain: false });

  assert.deepEqual(withoutNewest.validation, withNewest.validation);
  assert.deepEqual(withoutNewest.test, withNewest.test);
  assert.ok(withoutNewest.train.length < withNewest.train.length);
  assert.ok(withoutNewest.train.every(r => r.season === '2024-25'));
  assert.ok(withNewest.train.some(r => r.season === '2025-26'));

  const onlyNewest = splitRows(rows, seasons, { trainSeasons: ['2025-26'] });
  assert.deepEqual(onlyNewest.validation, withNewest.validation);
  assert.deepEqual(onlyNewest.test, withNewest.test);
  assert.ok(onlyNewest.train.every(r => r.season === '2025-26'));
});
