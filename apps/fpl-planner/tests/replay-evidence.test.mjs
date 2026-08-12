// What the replay tells the model it knows, and whether that is true.
//
// Both defects pinned here were found on 2026-08-12, both had been in every
// number this project ever published, and both are the same bug class as the
// free-transfer off-by-one: a SNAPSHOT stayed legal while the EVIDENCE behind
// it was wrong. Nothing in the suite could catch them, because every assertion
// checked that a probability was between zero and one, and a start probability
// of exactly 1.000 for the entire owned pool is between zero and one.
//
//   1. THE MISSING STARTS COLUMN. FPL added `starts` part way through 2022-23,
//      so the archive has it at zero for gameweeks 1 to 15. The model read that
//      as a league in which nobody ever starts, inferred that every minute
//      played was a substitute minute, and replayed a third of the evidence
//      base upside down.
//
//   2. THE EVIDENCE DENOMINATOR. The replay seeds half of the previous season
//      into a player's totals. Those totals were then divided by the number of
//      matches THIS season has played, so a returning starter's observed start
//      rate came out at 5.5 and clamped to 1.
//
// The tests below check the INVARIANTS rather than the two literal cases: a
// club fields exactly eleven players, and nobody can start more matches than he
// was present for. Either invariant catches the defect it was written for, and
// would also catch the next member of its class.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import { reconstructStarts, buildDataset, createAccumulator, gameStateAt, parseMergedGw } from '../js/engine/backtest.js';
import { projectMinutes, positionPriors, evidenceMatchesFor } from '../js/engine/minutes.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULES = buildRules(JSON.parse(readFileSync(join(here, 'fixtures', 'bootstrap.json'), 'utf8')));

// ---------------------------------------------------------------------------
// A tiny synthetic archive, written directly as parsed rows so a test can
// choose exactly which gameweeks carry a starts column.
// ---------------------------------------------------------------------------

const SQUAD = 16;          // per club, so a side has more players than it starts
const CLUBS = 4;

function row(over) {
  return {
    gw: 1, playerId: 1, name: 'p', position: 3, teamName: 'Alpha', opponentTeam: 2,
    fixtureId: 1, wasHome: true, kickoff: '2024-08-01T14:00:00Z',
    minutes: 0, starts: 0, totalPoints: 0, valueTenths: 50, selected: 1000,
    bonus: 0, bps: 0, saves: 0, goalsScored: 0, assists: 0, cleanSheets: 0,
    goalsConceded: 0, yellowCards: 0, redCards: 0, ownGoals: 0,
    penaltiesSaved: 0, penaltiesMissed: 0, xG: 0, xA: 0, xGC: 0,
    teamHScore: 1, teamAScore: 0, ...over,
  };
}

const CLUB_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'];

// Player n of a club plays 90 minutes when n <= 11, a cameo when n is 12 or 13,
// and nothing at all otherwise. `withStarts` decides whether the archive
// records who started, which is the whole subject of the first half of this
// file.
function season({ gws = 4, withStarts = true, startsFromGw = 1 } = {}) {
  const rows = [];
  let fixtureId = 0;
  for (let gw = 1; gw <= gws; gw++) {
    for (let pair = 0; pair < CLUBS / 2; pair++) {
      fixtureId++;
      const home = pair * 2 + 1;
      const away = pair * 2 + 2;
      for (const [club, isHome] of [[home, true], [away, false]]) {
        for (let n = 1; n <= SQUAD; n++) {
          // Rotate who is the eleventh starter, so start rates differ between
          // players rather than every player being identical.
          const rank = ((n + gw) % SQUAD) + 1;
          const minutes = rank <= 11 ? 90 : rank <= 13 ? 20 : 0;
          const recorded = withStarts && gw >= startsFromGw ? (rank <= 11 ? 1 : 0) : 0;
          rows.push(row({
            gw,
            playerId: club * 100 + n,
            name: `${CLUB_NAMES[club - 1]} ${n}`,
            position: n <= 2 ? 1 : n <= 7 ? 2 : n <= 12 ? 3 : 4,
            teamName: CLUB_NAMES[club - 1],
            opponentTeam: isHome ? away : home,
            fixtureId,
            wasHome: isHome,
            kickoff: `2024-08-${String(gw).padStart(2, '0')}T14:00:00Z`,
            minutes,
            starts: recorded,
            valueTenths: 40 + n,
            selected: 100000 - n * 1000,
          }));
        }
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 1. The missing starts column
// ---------------------------------------------------------------------------

test('a gameweek with no starts column gets exactly eleven starters per club', () => {
  const rows = season({ gws: 2, withStarts: false });
  const report = reconstructStarts(rows);

  assert.deepEqual(report.gameweeks, [1, 2], 'both gameweeks were missing the column');

  const bySide = new Map();
  for (const r of rows) {
    const key = `${r.fixtureId}|${r.teamName}`;
    bySide.set(key, (bySide.get(key) || 0) + r.starts);
  }
  assert.equal(bySide.size, CLUBS * 2, 'four clubs, two gameweeks');
  for (const [side, starters] of bySide) {
    assert.equal(starters, 11, `${side} fielded ${starters} starters`);
  }
  assert.equal(report.rows, 11 * CLUBS * 2);
});

test('the reconstructed starters are the players who played, longest first', () => {
  const rows = season({ gws: 1, withStarts: false });
  reconstructStarts(rows);
  for (const r of rows) {
    if (r.minutes === 90) assert.equal(r.starts, 1, `${r.name} played 90 and is not a starter`);
    if (r.minutes === 0) assert.equal(r.starts, 0, `${r.name} played nothing and is a starter`);
  }
});

test('reconstruction never invents a starter out of a player who did not play', () => {
  // Nine players available, so the eleven slots cannot be filled. The rule must
  // stop at nine rather than promoting someone with no minutes.
  const rows = [];
  for (let n = 1; n <= 14; n++) {
    rows.push(row({ playerId: n, name: `p${n}`, minutes: n <= 9 ? 90 : 0 }));
  }
  reconstructStarts(rows);
  assert.equal(rows.filter(r => r.starts === 1).length, 9);
  assert.ok(rows.filter(r => r.minutes === 0).every(r => r.starts === 0));
});

test('a gameweek that already carries starts is left byte-identical', () => {
  const rows = season({ gws: 2, withStarts: true });
  const before = rows.map(r => r.starts);
  const report = reconstructStarts(rows);
  assert.deepEqual(report.gameweeks, [], 'nothing to reconstruct');
  assert.deepEqual(rows.map(r => r.starts), before, 'real data was overwritten');
});

test('2022-23 shape: reconstruct the early gameweeks and leave the later ones alone', () => {
  // The real defect: the column arrives at gameweek 3 of this miniature.
  const rows = season({ gws: 4, withStarts: true, startsFromGw: 3 });
  const recordedBefore = rows.filter(r => r.gw >= 3 && r.starts === 1).length;
  const report = reconstructStarts(rows);

  assert.deepEqual(report.gameweeks, [1, 2]);
  assert.equal(rows.filter(r => r.gw >= 3 && r.starts === 1).length, recordedBefore);
  for (const gw of [1, 2]) {
    assert.equal(rows.filter(r => r.gw === gw && r.starts === 1).length, 11 * CLUBS);
  }
});

test('a gameweek nobody played is not a gameweek with a missing column', () => {
  const rows = [row({ gw: 1, minutes: 0 }), row({ gw: 1, playerId: 2, minutes: 0 })];
  const report = reconstructStarts(rows);
  assert.deepEqual(report.gameweeks, []);
  assert.ok(rows.every(r => r.starts === 0));
});

test('buildDataset reports what it had to reconstruct instead of hiding it', () => {
  const missing = buildDataset({ rows: season({ gws: 2, withStarts: false }), season: 'synthetic' });
  assert.equal(missing.startsReconstructed.gameweeks.length, 2);

  const complete = buildDataset({ rows: season({ gws: 2, withStarts: true }), season: 'synthetic' });
  assert.equal(complete.startsReconstructed, null, 'a complete archive claims no reconstruction');
});

test('without reconstruction the model inverts: everyone becomes a substitute', () => {
  // The defect itself, stated as a measurement. A dataset whose starts column is
  // zeroed and NOT reconstructed hands minutes.js a league where a 90-minute
  // regular has pStart 0. This is what 2022-23 gameweeks 1 to 15 looked like.
  const raw = season({ gws: 3, withStarts: false });
  for (const r of raw) r.starts = 0;
  const broken = buildDataset({ rows: raw.map(r => ({ ...r })), season: 'broken' });
  // Undo the reconstruction to recreate the old behaviour exactly.
  for (const p of broken.players.values()) for (const r of p.rows) r.starts = 0;

  const fixed = buildDataset({ rows: season({ gws: 3, withStarts: false }), season: 'fixed' });

  const pStartAt = (dataset) => {
    const accumulator = createAccumulator(dataset);
    for (let gw = 1; gw < 3; gw++) accumulator.absorb(gw);
    const gs = gameStateAt(dataset, 3, { rules: RULES, accumulator });
    const regular = [...gs.players.values()].sort((a, b) => b.minutes - a.minutes)[0];
    return projectMinutes(regular, { gameState: gs, gw: 3 }).pStart;
  };

  assert.ok(pStartAt(broken) < 0.05, 'the defect: a regular starter reads as a non-starter');
  assert.ok(pStartAt(fixed) > 0.5, 'reconstructed, the same player reads as a starter');
});

// ---------------------------------------------------------------------------
// 2. The evidence denominator
// ---------------------------------------------------------------------------

test('a player cannot have started more matches than he was present for', () => {
  // The invariant the old code broke. It is checked over every player of a
  // seeded replay, at four points of the season, because the defect was
  // largest at the start and never disappeared.
  const prior = buildDataset({ rows: season({ gws: 8 }), season: 'prior' });
  const current = buildDataset({ rows: season({ gws: 8 }), season: 'current' });

  for (const gw of [1, 2, 4, 8]) {
    const accumulator = createAccumulator(current, { priorDataset: prior });
    for (let g = 1; g < gw; g++) accumulator.absorb(g);
    const gs = gameStateAt(current, gw, { rules: RULES, accumulator });
    for (const p of gs.players.values()) {
      if (p.minutes <= 0) continue;
      assert.ok(
        p.starts <= p.evidenceMatches + 1e-9,
        `gw${gw}: ${p.webName} has ${p.starts} starts over ${p.evidenceMatches} matches of evidence`,
      );
    }
  }
});

test('the prior season is seeded into the denominator as well as the numerator', () => {
  const prior = buildDataset({ rows: season({ gws: 10 }), season: 'prior' });
  const current = buildDataset({ rows: season({ gws: 10 }), season: 'current' });
  const accumulator = createAccumulator(current, { priorDataset: prior, priorWeight: 0.5 });
  accumulator.absorb(1);
  const gs = gameStateAt(current, 2, { rules: RULES, accumulator });
  const p = [...gs.players.values()].find(x => x.minutes > 0);
  // Ten prior matches at half weight, plus the one absorbed gameweek.
  assert.ok(Math.abs(p.evidenceMatches - (0.5 * 10 + 1)) < 1e-9, `evidenceMatches ${p.evidenceMatches}`);
});

test('a half-time starter does not read as nailed just because last season is seeded', () => {
  // The literal shape of the defect: 19 matches of prior evidence at a 50%
  // start rate, two matches into the new season. Divided by two matches that is
  // a rate of 5.5, clamped to 1.000. Divided by the matches it covers it is
  // about 0.55, which is what the player is.
  const gs = {
    rules: { starters: 11, totalEvents: 38 },
    teams: new Map([[1, { id: 1 }], [2, { id: 2 }]]),
    players: new Map(),
    fixtures: [
      { id: 1, event: 1, teamH: 1, teamA: 2, finished: true },
      { id: 2, event: 2, teamH: 2, teamA: 1, finished: true },
      { id: 3, event: 3, teamH: 1, teamA: 2, finished: false },
    ],
    nextEvent: 3,
  };
  let id = 0;
  for (let i = 0; i < 40; i++) {
    id++;
    gs.players.set(id, {
      id, teamId: (i % 2) + 1, position: (i % 4) + 1, nowCost: 50, status: 'a', chanceNext: null,
      minutes: 950, starts: 10.5, evidenceMatches: 21,
    });
  }
  const subject = gs.players.get(1);
  const profile = projectMinutes(subject, { gameState: gs, gw: 3 });

  assert.ok(profile.pStart > 0.35 && profile.pStart < 0.75, `pStart ${profile.pStart}`);
  assert.ok(profile.pStart < 0.9, 'the defect was pStart pinned at 1.000');
  assert.ok(profile.pAppear >= profile.pStart && profile.pAppear <= 1);
});

test('position priors use the same denominator the players do', () => {
  // The old code inflated the priors by the same mechanism, so a shrunk rate was
  // being pulled toward an inflated target rather than corrected by it.
  const players = new Map();
  for (let i = 1; i <= 40; i++) {
    players.set(i, {
      id: i, teamId: (i % 2) + 1, position: 3, nowCost: 50, status: 'a', chanceNext: null,
      minutes: 900, starts: 10, evidenceMatches: 20,
    });
  }
  const gs = {
    rules: { starters: 11, totalEvents: 38 },
    teams: new Map([[1, { id: 1 }], [2, { id: 2 }]]),
    players,
    fixtures: [
      { id: 1, event: 1, teamH: 1, teamA: 2, finished: true },
      { id: 2, event: 2, teamH: 1, teamA: 2, finished: false },
    ],
  };
  const { priors } = positionPriors(gs);
  assert.ok(Math.abs(priors.get(3).startRate - 0.5) < 1e-9, `startRate ${priors.get(3).startRate}`);
});

test('a live payload has no evidence field and is measured exactly as before', () => {
  assert.equal(evidenceMatchesFor({ starts: 3 }, 7), 7, 'absent means "this season"');
  assert.equal(evidenceMatchesFor({ evidenceMatches: 0 }, 7), 7, 'zero evidence is no evidence');
  assert.equal(evidenceMatchesFor({ evidenceMatches: null }, 7), 7);
  assert.equal(evidenceMatchesFor({ evidenceMatches: 21 }, 7), 21);

  // And the fallback is an identity, not an approximation: declaring exactly
  // the team match count must reproduce the payload that declares nothing.
  const build = (extra) => {
    const players = new Map();
    for (let i = 1; i <= 20; i++) {
      players.set(i, {
        id: i, teamId: (i % 2) + 1, position: (i % 4) + 1, nowCost: 50, status: 'a', chanceNext: null,
        minutes: 60 * i, starts: i % 9, ...extra,
      });
    }
    return {
      rules: { starters: 11, totalEvents: 38 },
      teams: new Map([[1, { id: 1 }], [2, { id: 2 }]]),
      players,
      fixtures: [
        { id: 1, event: 1, teamH: 1, teamA: 2, finished: true },
        { id: 2, event: 2, teamH: 1, teamA: 2, finished: true },
        { id: 3, event: 3, teamH: 1, teamA: 2, finished: false },
      ],
    };
  };
  const bare = build({});
  const declared = build({ evidenceMatches: 2 });
  for (let i = 1; i <= 20; i++) {
    const a = projectMinutes(bare.players.get(i), { gameState: bare, gw: 3 });
    const b = projectMinutes(declared.players.get(i), { gameState: declared, gw: 3 });
    assert.equal(a.pStart, b.pStart, `player ${i}`);
    assert.equal(a.xMins, b.xMins, `player ${i}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Columns the archive HAS and the replay was not reading
//
// Defensive contribution arrived in 2025-26 and the archive carries its three
// component columns from that season on. The replay hardcoded them to zero with
// a comment saying the data did not exist, which was true when it was written
// and stopped being true when the season turned over. Found on 2026-08-12 by
// rebuilding every archive row's total_points from the scoring table: three
// seasons reconstruct at 100.00%, and 2025-26 misses on 12.3% of played rows by
// exactly -2, which is the defensive contribution the reconstruction could not
// see.
//
// The bug class is a comment that was true once. The test is that the replay
// reads a column WHEN IT EXISTS and reports zero when it does not, rather than
// either behaviour being hardcoded.
// ---------------------------------------------------------------------------

const DEFCON_HEADER = [
  'name', 'position', 'team', 'element', 'fixture', 'opponent_team', 'was_home', 'kickoff_time',
  'minutes', 'starts', 'total_points', 'value', 'selected', 'bonus', 'bps', 'saves',
  'goals_scored', 'assists', 'clean_sheets', 'goals_conceded', 'yellow_cards', 'red_cards',
  'own_goals', 'penalties_saved', 'penalties_missed', 'expected_goals', 'expected_assists',
  'expected_goals_conceded', 'team_h_score', 'team_a_score', 'GW',
];

function csvFor({ withDefCon }) {
  const header = withDefCon
    ? [...DEFCON_HEADER, 'clearances_blocks_interceptions', 'recoveries', 'tackles']
    : DEFCON_HEADER;
  const base = [
    'D1', 'DEF', 'Alpha', 11, 1, 2, 'True', '2025-08-01T14:00:00Z',
    90, 1, 6, 50, 1000, 0, 20, 0,
    0, 0, 1, 0, 0, 0,
    0, 0, 0, '0.1', '0.1',
    '0.9', 1, 0, 1,
  ];
  const row = withDefCon ? [...base, 12, 4, 3] : base;
  return `${header.join(',')}\n${row.join(',')}`;
}

test('the archive columns for defensive contribution are read when they exist', () => {
  const [row] = parseMergedGw(csvFor({ withDefCon: true }));
  assert.equal(row.cbit, 12);
  assert.equal(row.recoveries, 4);
  assert.equal(row.tackles, 3);
});

test('a season predating the stat reports zero rather than guessing', () => {
  const [row] = parseMergedGw(csvFor({ withDefCon: false }));
  assert.equal(row.cbit, 0);
  assert.equal(row.recoveries, 0);
  assert.equal(row.tackles, 0);
});

test('the components reach the game state and become a per-90 rate', () => {
  const rows = [];
  for (let gw = 1; gw <= 3; gw++) {
    for (let n = 1; n <= 14; n++) {
      rows.push(row({
        gw,
        playerId: n,
        name: `p${n}`,
        position: n <= 2 ? 1 : n <= 7 ? 2 : 3,
        fixtureId: gw,
        minutes: n <= 11 ? 90 : 0,
        starts: n <= 11 ? 1 : 0,
        cbit: n <= 11 ? 6 : 0,
        tackles: n <= 11 ? 3 : 0,
        recoveries: n <= 11 ? 4 : 0,
      }));
    }
  }
  const dataset = buildDataset({ rows, season: 'with-defcon' });
  const accumulator = createAccumulator(dataset);
  accumulator.absorb(1);
  accumulator.absorb(2);
  const gs = gameStateAt(dataset, 3, { rules: RULES, accumulator });

  const defender = [...gs.players.values()].find(p => p.position === 2 && p.minutes > 0);
  assert.equal(defender.cbit, 12, 'two matches of six');
  assert.equal(defender.tackles, 6);
  // A defender's composite is CBIT + tackles, so 18 over 180 minutes is 9 per 90.
  assert.ok(Math.abs(defender.per90.defCon - 9) < 1e-9, `per90 ${defender.per90.defCon}`);

  // A midfielder adds recoveries: (12 + 8 + 6) / 2 nineties = 13.
  const mid = [...gs.players.values()].find(p => p.position === 3 && p.minutes > 0);
  assert.ok(Math.abs(mid.per90.defCon - 13) < 1e-9, `per90 ${mid.per90.defCon}`);

  // A goalkeeper cannot earn it whatever his columns say.
  const gk = [...gs.players.values()].find(p => p.position === 1 && p.minutes > 0);
  assert.equal(gk.per90.defCon, 0);
});

test('a season with no such columns is bit-identical to the old hardcoded zero', () => {
  const rows = [];
  for (let gw = 1; gw <= 3; gw++) {
    for (let n = 1; n <= 14; n++) {
      rows.push(row({ gw, playerId: n, name: `p${n}`, position: 2, fixtureId: gw, minutes: 90, starts: 1 }));
    }
  }
  const dataset = buildDataset({ rows, season: 'no-defcon' });
  const accumulator = createAccumulator(dataset);
  accumulator.absorb(1);
  const gs = gameStateAt(dataset, 2, { rules: RULES, accumulator });
  for (const p of gs.players.values()) {
    assert.equal(p.cbit, 0);
    assert.equal(p.recoveries, 0);
    assert.equal(p.tackles, 0);
    assert.equal(p.per90.defCon, 0);
  }
});
