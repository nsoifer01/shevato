// Decision-quality metrics (scripts/decision-report.mjs), computed after the
// fact from a replay report's recorded decisions.
//
// The report is hand-built here, so every number below can be checked with a
// pencil: which captain was the squad's best, what each transfer returned over
// 1, 3 and 5 gameweeks (truncated at the season's end), that a Wildcard's moves
// are not counted as transfers, and how free transfers lost at the cap and
// rolled weeks are read off the before/after bank.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDataset } from '../js/engine/backtest.js';
import { decisionMetrics, pairedComparison } from '../scripts/decision-report.mjs';

const GWS = 4;
const SQUAD = Array.from({ length: 15 }, (_, i) => i + 1);

// Points by player and gameweek. Player 16 is the one bought in gameweek 2 for
// player 15; player 17 is bought on the Wildcard in gameweek 3 for player 14.
const POINTS = {
  1: [2, 2, 2, 2], 2: [9, 1, 1, 1], 3: [1, 3, 1, 1], 14: [1, 1, 1, 1],
  15: [1, 0, 2, 3], 16: [0, 6, 4, 1], 17: [9, 9, 9, 9],
};
const pts = (id, gw) => (POINTS[id] ? POINTS[id][gw - 1] : 1);

const rows = [];
for (let gw = 1; gw <= GWS; gw++) {
  for (let id = 1; id <= 17; id++) {
    rows.push({
      gw, playerId: id, name: `P${id}`, position: id === 1 || id === 12 ? 1 : 3, teamName: 'Alpha', opponentTeam: 2,
      fixtureId: gw, wasHome: true, kickoff: null, minutes: 90, starts: 1, totalPoints: pts(id, gw), valueTenths: 50,
      selected: 1, bonus: 0, bps: 0, saves: 0, goalsScored: 0, assists: 0, cleanSheets: 0, goalsConceded: 0,
      yellowCards: 0, redCards: 0, ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0, xG: 0, xA: 0, xGC: 0,
      teamHScore: 0, teamAScore: 0,
    });
  }
}
const DATASET = buildDataset({ rows, season: 'decisions' });

const decision = (squad, over = {}) => ({
  squad, startingXI: squad.slice(0, 11), bench: squad.slice(11), captain: squad[1], viceCaptain: squad[0],
  transfersIn: [], transfersOut: [], freeTransfersAfter: 1, ...over,
});
const afterGw2 = SQUAD.filter(id => id !== 15).concat(16);
const afterGw3 = afterGw2.filter(id => id !== 14).concat(17);

const GWROWS = [
  // GW1: the draft. Captain 2 scored 9, the squad's best: a hit.
  { gw: 1, chip: null, transfers: 0, freeTransfers: null, captain: 2, benchPoints: 3, hits: 0, netPoints: 50, decision: decision(SQUAD) },
  // GW2: one free transfer, 15 out for 16. Captain 2 scored 1, squad best is 16's 6: a miss, not top 3.
  {
    gw: 2, chip: null, transfers: 1, freeTransfers: 1, captain: 2, benchPoints: 2, hits: 0, netPoints: 40,
    decision: decision(afterGw2, { transfersIn: [16], transfersOut: [15], freeTransfersAfter: 1 }),
  },
  // GW3: a Wildcard (14 out, 17 in): its move is not a transfer.
  {
    gw: 3, chip: 'wildcard', transfers: 1, freeTransfers: 1, captain: 17, benchPoints: 1, hits: 0, netPoints: 60,
    decision: decision(afterGw3, { transfersIn: [17], transfersOut: [14], freeTransfersAfter: 1 }),
  },
  // GW4: a roll that reaches a bank of 2 (no cap loss).
  { gw: 4, chip: null, transfers: 0, freeTransfers: 1, captain: 17, benchPoints: 0, hits: 0, netPoints: 45, decision: decision(afterGw3, { freeTransfersAfter: 2 }) },
];

test('captaincy is judged against the fifteen that played that gameweek', () => {
  const m = decisionMetrics({ gws: GWROWS, dataset: DATASET });
  assert.equal(m.captain.weeks, 4);
  // GW1 hit (9 = best), GW2 miss (1 vs 6), GW3 hit (17's 9), GW4 hit (9).
  assert.equal(m.captain.bestRate, 3 / 4);
  assert.equal(m.captain.points, (9 + 1 + 9 + 9) / 4);
  assert.equal(m.captain.squadBest, (9 + 6 + 9 + 9) / 4);
  // GW2: the squad scored 6, 3 and 2 at the top, so a captain on 1 is not in the top 3.
  assert.equal(m.captain.top3Rate, 3 / 4);
});

test('a transfer is scored as the player in minus the player out, Wildcard moves excluded', () => {
  const m = decisionMetrics({ gws: GWROWS, dataset: DATASET });
  assert.equal(m.transfers.count, 1, 'the Wildcard swap of 14 for 17 is not a transfer');
  // 16 minus 15 from gameweek 2: (6-0), (4-2), (1-3), then the season ends.
  assert.equal(m.transfers.gain.gw1, 6);
  assert.equal(m.transfers.gain.gw3, 6 + 2 - 2);
  assert.equal(m.transfers.gain.gw5, 6, 'five gameweeks truncate at the end of the season');
  assert.equal(m.transfers.sharePositive3, 1);
  assert.equal(m.benchPoints, 6);
  assert.equal(m.seasonPoints, 195, 'without totals, season points add up the rows');
});

test('free transfers: weeks with 3+ banked, losses at the cap, and rolls', () => {
  const capped = [
    { gw: 2, chip: null, transfers: 0, freeTransfers: 2, decision: decision(SQUAD, { freeTransfersAfter: 2 }) }, // rolled at a cap of 2: one lost
    { gw: 3, chip: null, transfers: 0, freeTransfers: 3, decision: decision(SQUAD, { freeTransfersAfter: 4 }) }, // rolled, banked
    { gw: 4, chip: null, transfers: 1, freeTransfers: 4, decision: decision(SQUAD, { freeTransfersAfter: 4 }) }, // used one, earned one
    { gw: 5, chip: 'freehit', transfers: 3, freeTransfers: 4, decision: decision(SQUAD, { freeTransfersAfter: 4 }) }, // chip weeks never count
    { gw: 6, chip: null, transfers: 0, freeTransfers: 5, decision: decision(SQUAD, { freeTransfersAfter: 5 }) }, // at the 5 cap: one lost
    { gw: 7, chip: null, transfers: 0, freeTransfers: 1, decision: decision(SQUAD, { freeTransfersAfter: null }) }, // unlimited next week: unknowable
  ];
  const m = decisionMetrics({ gws: capped, dataset: DATASET, fromGw: 99 });
  assert.equal(m.weeksThreePlusFt, 4);
  assert.equal(m.ftLostAtCap, 2);
  assert.equal(m.rolledWeeks, 4, 'every non-chip week with no transfer, from gameweek 2');
  assert.equal(m.captain.weeks, 0, 'fromGw past the season scores no captaincy');
});

test('a report written before decisions were recorded says so instead of scoring nothing silently', () => {
  const m = decisionMetrics({ gws: GWROWS.map(({ decision: _d, ...rest }) => rest), dataset: DATASET });
  assert.equal(m.missingDecision, 4);
  assert.equal(m.captain.weeks, 0);
});

test('paired comparison averages the seeds inside a season before counting seasons', () => {
  const cell = (season, seed, points, strategy = 'planner') => ({
    season, seed, strategy,
    metrics: { ...decisionMetrics({ gws: GWROWS, dataset: DATASET }), seasonPoints: points },
  });
  const a = [cell('s1', 1, 100), cell('s1', 2, 110), cell('s2', 1, 200), cell('s2', 2, 200)];
  const b = [cell('s1', 1, 110), cell('s1', 2, 130), cell('s2', 1, 190), cell('s2', 2, 200)];
  const p = pairedComparison(a, b);
  const s1 = p.perSeason.find(x => x.season === 's1');
  assert.equal(s1.diff.seasonPoints, 15);
  assert.equal(p.perSeason.find(x => x.season === 's2').diff.seasonPoints, -5);
  const o = p.overall.planner.seasonPoints;
  assert.equal(o.n, 2, 'two seasons, not four seed cells');
  assert.equal(o.mean, 5);
  assert.equal(o.wins, 1);
  assert.equal(o.losses, 1);
  assert.ok(Math.abs(o.se - 10) < 1e-9);
});
