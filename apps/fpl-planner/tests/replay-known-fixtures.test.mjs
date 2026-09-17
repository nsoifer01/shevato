// The replay's calendar is the one production could see at each deadline, not
// the season's final fixture list (registry entry 31).
//
// The archive only has the final list, so a match postponed from round 5 and
// played in a gameweek 12 double sat in gameweek 12 from the first deadline,
// and every decision that looks past the week being decided saw the double
// weeks before anyone could. These tests pin the reconstruction: fixture ids
// number the ORIGINAL calendar, a moved match stays in its original round
// until its move is known, is undated while it is postponed, and the week being
// decided always reads exactly as the final list does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import {
  buildDataset, createAccumulator, productionGameStateAt, knownFixtureEvent, originalSchedule,
  FIXTURE_ANNOUNCE_LEAD,
} from '../js/engine/backtest.js';
import { fixturesForTeam } from '../js/engine/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const RULES = buildRules(JSON.parse(readFileSync(join(here, 'fixtures', 'bootstrap.json'), 'utf8')));

const CLUBS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
const PER_ROUND = CLUBS.length / 2;
const GWS = 38;
const dayOf = gw => new Date(Date.UTC(2025, 7, 10) + (gw - 1) * 7 * 86400000).toISOString();
const roundOf = id => Math.ceil(id / PER_ROUND);

// A 38-round season of six clubs, fixture ids in calendar order, with `moves`
// mapping a fixture id to the gameweek it was actually played in.
function seasonRows(moves = {}) {
  const rows = [];
  let fixtureId = 0;
  for (let round = 1; round <= GWS; round++) {
    for (let pair = 0; pair < PER_ROUND; pair++) {
      fixtureId++;
      const gw = moves[fixtureId] || round;
      const home = ((pair * 2 + round) % CLUBS.length) + 1;
      const away = ((pair * 2 + 1 + round) % CLUBS.length) + 1;
      for (const [club, isHome] of [[home, true], [away, false]]) {
        for (let n = 1; n <= 15; n++) {
          rows.push({
            gw, playerId: club * 100 + n, name: `${CLUBS[club - 1]} ${n}`,
            position: n <= 2 ? 1 : n <= 7 ? 2 : n <= 12 ? 3 : 4,
            teamName: CLUBS[club - 1], opponentTeam: isHome ? away : home, fixtureId, wasHome: isHome,
            kickoff: gw === round ? dayOf(gw) : new Date(Date.parse(dayOf(gw)) + 3 * 86400000).toISOString(),
            minutes: n <= 11 ? 90 : 0, starts: n <= 11 ? 1 : 0, totalPoints: n <= 11 ? 2 : 0,
            valueTenths: 45, selected: 100000, bonus: 0, bps: 10, saves: 0, goalsScored: 0, assists: 0,
            cleanSheets: 0, goalsConceded: 1, yellowCards: 0, redCards: 0, ownGoals: 0, penaltiesSaved: 0,
            penaltiesMissed: 0, xG: 0.1, xA: 0.05, xGC: 1.2, teamHScore: 1, teamAScore: 1,
          });
        }
      }
    }
  }
  return rows;
}

// Fixture 13 is round 5, played in gameweek 12 (a blank in 5, a double in 12);
// fixture 59 is round 20, brought forward to gameweek 17.
const LATER = 13;
const EARLIER = 59;
const DATASET = buildDataset({ rows: seasonRows({ [LATER]: 12, [EARLIER]: 17 }), season: '2025-26' });
const fixtureById = id => DATASET.fixtures.find(f => f.id === id);

function fixturesAt(gw, fixtureLead) {
  const accumulator = createAccumulator(DATASET, {});
  for (let g = 1; g < gw; g++) accumulator.absorb(g);
  const opts = { rules: RULES, accumulator };
  if (fixtureLead !== undefined) opts.fixtureLead = fixtureLead;
  return productionGameStateAt(DATASET, gw, opts);
}

test('fixture ids number the original calendar, so the reschedules are exactly the fixtures played outside their round', () => {
  assert.equal(roundOf(LATER), 5);
  assert.equal(roundOf(EARLIER), 20);
  const moved = DATASET.fixtures.filter(f => roundOf(f.id) !== f.event).map(f => f.id).sort((a, b) => a - b);
  assert.deepEqual(moved, [LATER, EARLIER]);
  const schedule = originalSchedule(DATASET);
  assert.equal(schedule.perRound, PER_ROUND);
  assert.equal(schedule.roundKickoff.get(5), dayOf(5), 'a round keeps the date of its unmoved matches');
});

test('a postponed match sits in its original round, is undated while postponed, and is dated once its move is known', () => {
  const f = fixtureById(LATER);
  const lead = 3;
  const at = gw => knownFixtureEvent(f, gw, { lead, perRound: PER_ROUND });
  for (const gw of [1, 2, 3, 4]) assert.equal(at(gw), 5, `gw${gw}: still scheduled in round 5`);
  for (const gw of [5, 6, 7, 8]) assert.equal(at(gw), null, `gw${gw}: postponed, no date yet`);
  for (const gw of [9, 10, 11, 12, 13]) assert.equal(at(gw), 12, `gw${gw}: dated in gameweek 12`);
  assert.equal(knownFixtureEvent(f, 1, { lead: null, perRound: PER_ROUND }), 12, 'lead null replays the final list');
});

test('a match brought forward stays in its round until the move is known, with no undated gap', () => {
  const f = fixtureById(EARLIER);
  const at = gw => knownFixtureEvent(f, gw, { lead: 3, perRound: PER_ROUND });
  for (const gw of [1, 10, 13]) assert.equal(at(gw), 20, `gw${gw}: still round 20`);
  for (const gw of [14, 17, 30]) assert.equal(at(gw), 17, `gw${gw}: dated in gameweek 17`);
});

test('the replayed payload carries the calendar as known, and the week being decided always reads true', () => {
  const later = fixtureById(LATER);
  const clubs = [later.teamH, later.teamA];
  const lead = FIXTURE_ANNOUNCE_LEAD;
  for (let gw = 2; gw <= 20; gw++) {
    const { gameState } = fixturesAt(gw);
    const final = fixturesAt(gw, null).gameState;
    const shown = gameState.fixtures.find(x => x.id === LATER);
    const expected = gw < 5 ? 5 : gw < 12 - lead ? null : 12;
    assert.equal(shown.event, expected, `gw${gw}: fixture ${LATER} is in ${expected}`);
    if (expected === null) assert.equal(shown.kickoff, null, 'an undated match has no kickoff');
    if (expected === 5) assert.equal(shown.kickoff, dayOf(5), 'a match in its original round carries that round\'s date');
    for (const club of clubs) {
      assert.equal(
        fixturesForTeam(gameState, club, gw).length,
        fixturesForTeam(final, club, gw).length,
        `gw${gw}: club ${club} plays as many matches this week as the final list says`,
      );
    }
    assert.equal(final.fixtures.find(x => x.id === LATER).event, 12, 'the final list is available for comparison');
  }
  // Before the move is known the double is invisible: gameweek 12 shows one
  // match for the clubs, where the final list already shows two.
  const early = fixturesAt(4).gameState;
  assert.equal(fixturesForTeam(early, clubs[0], 12).length, 1);
  assert.equal(fixturesForTeam(fixturesAt(4, null).gameState, clubs[0], 12).length, 2);
  assert.equal(fixturesForTeam(early, clubs[0], 5).length, 1, 'and round 5 is not a blank yet');
});

test('a dataset whose fixture ids do not number a whole calendar replays its final list', () => {
  const rows = seasonRows().filter(r => r.fixtureId !== 7);
  const partial = buildDataset({ rows, season: '2025-26' });
  assert.equal(originalSchedule(partial), null);
});
