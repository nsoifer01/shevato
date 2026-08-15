// Ingestion-time protection against duplicate training rows.
//
// The upstream per-gameweek files are concatenated weekly snapshots and contain
// a handful of rows emitted twice, character for character. A repeated row is
// not extra evidence: it lands in the player's prior history twice (inflating
// minutes, points and starts for every later gameweek) and produces a second
// identical training example, which is the same as giving that one observation
// double weight.
//
// The distinction this file exists to prove: a DOUBLE GAMEWEEK is also two rows
// for the same player and the same gameweek, and there are several hundred of
// them per season. Those are two real matches with different fixture ids and
// they carry real evidence, so they must survive untouched. Only a row that is
// identical in EVERY column is dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  parseCsv, dedupeRows, buildFeatureRows, REQUIRED_COLUMNS, playerKeyFor,
} from '../scripts/train-model.mjs';
import { DATA_DIR } from '../scripts/fetch-history.mjs';

const COLUMNS = [...REQUIRED_COLUMNS, 'kickoff_time', 'round'];

// A row that varies with the gameweek, so a duplicated one actually moves the
// features rather than being absorbed by identical numbers.
function row({ element, gw, fixture, opponent = 20 - gw, home = gw % 2 === 0, minutes = 60 + gw }) {
  return {
    element: String(element),
    name: `Player ${element}`,
    position: element === 1 ? 'MID' : 'DEF',
    team: element === 1 ? '3' : '7',
    GW: String(gw),
    fixture: String(fixture),
    opponent_team: String(opponent),
    was_home: home ? 'True' : 'False',
    value: String(70 + gw),
    minutes: String(minutes),
    starts: '1',
    expected_goals: (0.1 * gw).toFixed(2),
    expected_assists: (0.05 * gw).toFixed(2),
    expected_goals_conceded: (0.9 + 0.1 * gw).toFixed(2),
    bps: String(10 + gw),
    saves: '0',
    total_points: String(2 + (gw % 4)),
    team_h_score: String(gw % 3),
    team_a_score: String((gw + 1) % 3),
    kickoff_time: `2025-08-${String(10 + gw).padStart(2, '0')}T14:00:00Z`,
    round: String(gw),
  };
}

function toCsv(rows) {
  return [COLUMNS.join(','), ...rows.map(r => COLUMNS.map(c => r[c]).join(','))].join('\n') + '\n';
}

const GWS = [1, 2, 3, 4, 5, 6, 7, 8];
const cleanRows = [
  ...GWS.map(gw => row({ element: 1, gw, fixture: 100 + gw })),
  ...GWS.map(gw => row({ element: 2, gw, fixture: 200 + gw })),
];

const parse = (rows) => parseCsv(toCsv(rows)).rows;

test('a byte-identical repeated row is collapsed', () => {
  const withDuplicate = [...cleanRows];
  // Exactly what the upstream file does: the same line again, unchanged.
  withDuplicate.splice(4, 0, { ...cleanRows[3] });

  const parsed = parse(withDuplicate);
  assert.equal(parsed.length, cleanRows.length + 1, 'the CSV really does carry the row twice');

  const { rows: deduped, duplicates } = dedupeRows(parsed);
  assert.equal(duplicates, 1);
  assert.deepEqual(deduped, parse(cleanRows), 'what survives is the file without the repeat, in the original order');
});

test('a genuine double gameweek is preserved: same player, same gameweek, different fixture', () => {
  const doubleGw = [...cleanRows];
  const second = row({ element: 1, gw: 5, fixture: 999, opponent: 4, home: false, minutes: 88 });
  doubleGw.splice(5, 0, second);

  const parsed = parse(doubleGw);
  const { rows: deduped, duplicates } = dedupeRows(parsed);

  assert.equal(duplicates, 0, 'two real matches are not a duplicate');
  assert.equal(deduped.length, parsed.length);
  const gw5 = deduped.filter(r => r.element === '1' && r.GW === '5');
  assert.equal(gw5.length, 2);
  assert.deepEqual(gw5.map(r => r.fixture).sort(), ['105', '999']);
});

test('a row that differs in a single character is not a duplicate', () => {
  for (const column of ['minutes', 'total_points', 'fixture', 'opponent_team', 'was_home', 'value', 'kickoff_time']) {
    const nearMiss = { ...cleanRows[3], [column]: `${cleanRows[3][column]}9` };
    const { duplicates } = dedupeRows(parse([...cleanRows, nearMiss]));
    assert.equal(duplicates, 0, `rows differing in ${column} are different rows`);
  }
});

test('the collapsed duplicate cannot reach the training set or the prior history', () => {
  const clean = buildFeatureRows(parse(cleanRows), { season: 'synthetic' });
  const withDuplicate = [...cleanRows];
  withDuplicate.splice(4, 0, { ...cleanRows[3] });
  const raw = buildFeatureRows(parse(withDuplicate), { season: 'synthetic' });
  const guarded = buildFeatureRows(dedupeRows(parse(withDuplicate)).rows, { season: 'synthetic' });

  // The guard is load-bearing: without it the duplicate buys an extra training
  // example AND corrupts every later row's season-to-date features.
  assert.equal(raw.length, clean.length + 1, 'unguarded, the repeat becomes a second training row');
  const rawGw5 = raw.find(r => r.playerKey === playerKeyFor('synthetic', '1') && r.gw === 5);
  const cleanGw5 = clean.find(r => r.playerKey === playerKeyFor('synthetic', '1') && r.gw === 5);
  assert.notDeepEqual(rawGw5.features, cleanGw5.features, 'unguarded, the repeat is counted in the prior history too');

  assert.deepEqual(guarded, clean, 'guarded, the file with the repeat trains exactly like the file without it');
});

test('a double gameweek keeps its second row as its own training example', () => {
  const doubleGw = [...cleanRows];
  doubleGw.splice(5, 0, row({ element: 1, gw: 5, fixture: 999, opponent: 4, home: false, minutes: 88 }));
  const built = buildFeatureRows(dedupeRows(parse(doubleGw)).rows, { season: 'synthetic' });

  const gw5 = built.filter(r => r.playerKey === playerKeyFor('synthetic', '1') && r.gw === 5);
  assert.equal(gw5.length, 2, 'both halves of a double gameweek are evidence');
  assert.notDeepEqual(gw5[0].features, gw5[1].features, 'and the second one knows the first has been played');
});

test('deduping an empty or single-row file is a no-op', () => {
  assert.deepEqual(dedupeRows([]), { rows: [], duplicates: 0 });
  const single = parse([cleanRows[0]]);
  assert.deepEqual(dedupeRows(single), { rows: single, duplicates: 0 });
});

// The real files are gitignored (fetch-history.mjs downloads them), so this runs
// only on a machine that has them.
test('the real seasons: repeats are dropped, double gameweeks are not', (t) => {
  const seasons = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter(name => fs.existsSync(path.join(DATA_DIR, name, 'merged_gw.csv')))
    : [];
  if (!seasons.length) {
    t.skip('no downloaded seasons in .data (run scripts/fetch-history.mjs)');
    return;
  }

  for (const season of seasons) {
    const { rows } = parseCsv(fs.readFileSync(path.join(DATA_DIR, season, 'merged_gw.csv'), 'utf8'));
    const { rows: deduped, duplicates } = dedupeRows(rows);
    assert.equal(deduped.length + duplicates, rows.length);
    assert.equal(dedupeRows(deduped).duplicates, 0, 'deduping is idempotent');

    const samePlayerSameGw = new Map();
    for (const r of deduped) {
      const key = `${r.element}|${r.GW}`;
      samePlayerSameGw.set(key, (samePlayerSameGw.get(key) || 0) + 1);
    }
    const doubles = [...samePlayerSameGw.values()].filter(n => n > 1).length;
    assert.ok(doubles > 0, `${season} should still contain double gameweeks after deduping`);
    t.diagnostic(`${season}: ${rows.length} rows, ${duplicates} byte-identical duplicate(s) dropped, ${doubles} double-gameweek player-gameweeks kept`);
  }
});

/* -------------------------------------------------- the skip set is guarded */

// One test above runs only against the gitignored .data archive and skips
// silently without it. This guard makes that visible the same way
// player-identity.test.mjs does: the count of archive-gated skips is pinned by
// scanning this file's own source (so a gated test added or removed later
// fails here until the pin moves with it), with the archive present the gate
// must be open, and without it exactly the pinned number must be skipping.
test('the archive-gated skip set is exactly what the archive state implies', (t) => {
  const source = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const gatedInSource = (source.match(/\bt\.skip\(/g) || []).length;
  assert.equal(gatedInSource, 1,
    'archive-gated tests in this file; a changed count means one was added or removed - update this guard in the same change');

  const seasons = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter(name => fs.existsSync(path.join(DATA_DIR, name, 'merged_gw.csv')))
    : [];
  const skipping = seasons.length ? 0 : 1;
  t.diagnostic(`archive seasons held: ${seasons.length ? seasons.join(', ') : 'none'}; gated tests skipping: ${skipping} of ${gatedInSource}`);

  if (seasons.length) {
    assert.equal(skipping, 0, 'with the archive present the real-seasons test must run');
  } else {
    assert.equal(skipping, gatedInSource, 'without the archive exactly the gated test skips');
  }
});
