// availability.js inside backtest.js: the injury join and the leakage rule.
//
// The replay used to hand every historical player `status: 'a'` and
// `chanceNext: null`, so it believed a whole league was fit for a whole season.
// These tests cover the two things that fix has to get right:
//
//   THE JOIN. API-Football names a player and a club; the archive names him its
//   own way and identifies him by element id. A missed join costs a signal. A
//   WRONG join invents an injury for a fit player and makes the planner sell
//   him, so every rung is club constrained and every rung demands a unique
//   candidate.
//
//   THE LEAKAGE RULE. A record is attached to a fixture KICKOFF, which is after
//   the deadline the planner decides at. A record from gameweek N used in
//   gameweek N is the team sheet, not a forecast. Only records whose fixture
//   kicked off strictly before the gameweek N deadline may be read, and the
//   test at the bottom fails if that is relaxed by even one fixture.
//
// No downloaded data is touched here: every record is synthetic and every
// season is built in the archive's own CSV shape.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDataset,
  joinAvailability,
  buildAvailabilityIndex,
  leakageBoundaryMs,
  normalizeName,
  normalizeTeamName,
  gameStateAt,
  createAccumulator,
  AVAILABILITY_PARAMS,
} from '../js/engine/backtest.js';
import { buildRules } from '../js/engine/rules.js';
import bootstrap from './fixtures/bootstrap.json' with { type: 'json' };

const RULES = buildRules(bootstrap);

// --- a two club league, ten gameweeks, one match each per gameweek ----------

const CLUBS = [
  { id: 1, name: 'Man Utd' },
  { id: 2, name: 'Nott\'m Forest' },
];

const SQUAD = [
  { id: 11, club: 1, name: 'Rasmus Højlund', position: 'FWD' },
  { id: 12, club: 1, name: 'Dominic Solanke-Mitchell', position: 'FWD' },
  { id: 13, club: 1, name: 'Albert Sambi Lokonga', position: 'MID' },
  { id: 14, club: 1, name: 'Marc Cucurella Saseta', position: 'DEF' },
  { id: 15, club: 1, name: 'Tomiyasu Takehiro', position: 'DEF' },
  { id: 16, club: 1, name: 'David Raya Martin', position: 'GK' },
  { id: 21, club: 2, name: 'Emiliano Buendía Stati', position: 'MID' },
  { id: 22, club: 2, name: 'Michael Obafemi', position: 'FWD' },
  { id: 23, club: 2, name: 'Morgan Gibbs-White', position: 'MID' },
  { id: 24, club: 2, name: 'Neco Williams', position: 'DEF' },
  { id: 25, club: 2, name: 'Danilo dos Santos', position: 'MID' },
  { id: 26, club: 2, name: 'Matz Sels', position: 'GK' },
];

const GWS = 10;
const kickoffFor = (gw) => new Date(Date.UTC(2023, 7, 12 + (gw - 1) * 7, 14, 0, 0)).toISOString();

// `absent` is a set of "playerId:gw" that produced no minutes.
function syntheticCsv({ absent = new Set() } = {}) {
  const header = [
    'name', 'position', 'team', 'element', 'fixture', 'opponent_team', 'was_home',
    'kickoff_time', 'minutes', 'starts', 'total_points', 'value', 'selected', 'bonus', 'bps',
    'saves', 'goals_scored', 'assists', 'clean_sheets', 'goals_conceded', 'yellow_cards',
    'red_cards', 'own_goals', 'penalties_saved', 'penalties_missed', 'expected_goals',
    'expected_assists', 'expected_goals_conceded', 'team_h_score', 'team_a_score', 'GW',
  ];
  const lines = [header.join(',')];
  for (let gw = 1; gw <= GWS; gw++) {
    for (const p of SQUAD) {
      const home = p.club === 1;
      const out = absent.has(`${p.id}:${gw}`);
      lines.push([
        `"${p.name}"`, p.position, `"${CLUBS[p.club - 1].name}"`, p.id, gw,
        p.club === 1 ? 2 : 1, home ? 'True' : 'False', kickoffFor(gw),
        out ? 0 : 90, out ? 0 : 1, out ? 0 : 5, 50, 1000, 0, 10,
        0, 0, 0, 0, 1, 0, 0, 0, 0, 0, '0.10', '0.10', '1.00', 1, 1, gw,
      ].join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

const record = (playerName, teamName, gw, type = 'Missing Fixture', reason = 'Knee Injury') => ({
  playerName, teamName, type, reason, fixtureDate: kickoffFor(gw), fixtureId: gw, playerId: null,
});

// --- normalisation ---------------------------------------------------------

test('normalisation folds accents and the letters NFD cannot decompose', () => {
  assert.equal(normalizeName('Bruno Guimarães'), 'bruno guimaraes');
  assert.equal(normalizeName('Rasmus Højlund'), 'rasmus hojlund');
  assert.equal(normalizeName('Christian Nørgaard'), 'christian norgaard');
  assert.equal(normalizeName("N'Golo Kanté"), 'ngolo kante');
  // A stripped o would leave "hjlund", which matches nothing at all.
  assert.ok(!normalizeName('Rasmus Højlund').includes('hjlund'));
});

test('the four clubs the two sources spell differently map onto each other', () => {
  assert.equal(normalizeTeamName('Manchester United'), normalizeTeamName('Man Utd'));
  assert.equal(normalizeTeamName('Manchester City'), normalizeTeamName('Man City'));
  assert.equal(normalizeTeamName('Nottingham Forest'), normalizeTeamName("Nott'm Forest"));
  assert.equal(normalizeTeamName('Tottenham'), normalizeTeamName('Spurs'));
  assert.notEqual(normalizeTeamName('Man Utd'), normalizeTeamName('Man City'));
});

// --- the join --------------------------------------------------------------

const DATASET = buildDataset({ csv: syntheticCsv(), season: 'synthetic-availability' });

test('the join reaches every spelling the two sources actually disagree on', () => {
  const records = [
    record('R. Hojlund', 'Manchester United', 2),          // folded letter
    record('D. Solanke', 'Manchester United', 2),           // half a double barrelled name
    record('A. S. Lokonga', 'Manchester United', 2),        // two initials
    record('M. Cucurella', 'Manchester United', 2),         // maternal surname trails
    record('T. Tomiyasu', 'Manchester United', 2),          // family name first
    record('E. Buendia', 'Nottingham Forest', 2),           // accent plus trailing surname
    record('Michael Obafemi', 'Nottingham Forest', 2),      // full name, exact
    record('M. Gibbs-White', 'Nottingham Forest', 2),       // hyphen on both sides
  ];
  const joined = joinAvailability(DATASET, records);
  assert.equal(joined.stats.matchedNames, 8, JSON.stringify(joined.stats.unmatchedSample));
  assert.equal(joined.stats.matchedRecords, 8);
  for (const id of [11, 12, 13, 14, 15, 21, 22, 23]) {
    assert.ok(joined.byPlayer.has(id), `player ${id} should have been joined`);
  }
});

test('the join is club constrained, so the right name at the wrong club is not a match', () => {
  const joined = joinAvailability(DATASET, [record('M. Obafemi', 'Manchester United', 2)]);
  assert.equal(joined.stats.matchedNames, 0);
  assert.equal(joined.byPlayer.size, 0);
});

test('a name two players in one club answer to is left unmatched, never guessed', () => {
  const csv = syntheticCsv();
  // Two players who both normalise to a "Danilo" at the same club.
  const withTwin = csv.replaceAll('"Neco Williams",DEF', '"Danilo Luiz da Silva",DEF');
  const dataset = buildDataset({ csv: withTwin, season: 'twins' });
  const joined = joinAvailability(dataset, [record('Danilo', "Nott'm Forest", 2)]);

  assert.equal(joined.stats.matchedNames, 0, 'an ambiguous name must not be assigned');
  assert.equal(joined.stats.ambiguous, 1);
  assert.equal(joined.byPlayer.size, 0);
});

test('an unmatched player is reported, not silently dropped', () => {
  const records = [record('Casemiro', 'Manchester United', 2), record('Casemiro', 'Manchester United', 3)];
  const joined = joinAvailability(DATASET, records);
  assert.equal(joined.stats.matchedNames, 0);
  assert.equal(joined.stats.unmatched, 1);
  assert.equal(joined.stats.records, 2);
  assert.deepEqual(
    joined.stats.unmatchedSample.map(u => [u.name, u.records]),
    [['Casemiro', 2]],
  );
});

test('the join is deterministic: the same records in any order give the same answer', () => {
  const records = [
    record('R. Hojlund', 'Manchester United', 2),
    record('A. S. Lokonga', 'Manchester United', 3),
    record('E. Buendia', 'Nottingham Forest', 4),
    record('Casemiro', 'Manchester United', 5),
  ];
  const forward = joinAvailability(DATASET, records);
  const backward = joinAvailability(DATASET, records.slice().reverse());
  assert.deepEqual(
    [...forward.byPlayer.keys()].sort(),
    [...backward.byPlayer.keys()].sort(),
  );
  assert.deepEqual(forward.stats.byMethod, backward.stats.byMethod);
  assert.equal(forward.stats.matchedRecords, backward.stats.matchedRecords);
});

// --- the leakage rule ------------------------------------------------------

test('the boundary for a gameweek is that gameweek own earliest kickoff', () => {
  for (let gw = 1; gw <= GWS; gw++) {
    assert.equal(leakageBoundaryMs(DATASET, gw), Date.parse(kickoffFor(gw)));
  }
  assert.equal(leakageBoundaryMs(DATASET, GWS + 1), null);
});

test('a record from the gameweek being decided NEVER reaches that gameweek', () => {
  // Obafemi is listed for, and misses, every gameweek from 4 onwards.
  const absent = new Set();
  const records = [];
  for (let gw = 4; gw <= GWS; gw++) {
    absent.add(`22:${gw}`);
    records.push(record('Michael Obafemi', "Nott'm Forest", gw));
  }
  const dataset = buildDataset({ csv: syntheticCsv({ absent }), season: 'leak' });
  const index = buildAvailabilityIndex(dataset, records);

  // Gameweek 4 is the first one he misses. Its own record is same gameweek
  // information and must be invisible, so the planner still thinks he is fit.
  assert.equal(index.stateFor(22, 4), null, 'gameweek 4 must not see its own record');
  // Gameweek 5 may see gameweek 4, and only then does the doubt appear.
  const gw5 = index.stateFor(22, 5);
  assert.ok(gw5, 'gameweek 5 may read the gameweek 4 record');
  assert.equal(gw5.run, 1);
  assert.equal(gw5.status, 'd');
  assert.ok(gw5.chanceNext > 0 && gw5.chanceNext < 1);
});

test('THE RULE, pinned: nothing at or after the boundary is readable, and relaxing it fails here', () => {
  const absent = new Set();
  const records = [];
  for (let gw = 4; gw <= GWS; gw++) {
    absent.add(`22:${gw}`);
    records.push(record('Michael Obafemi', "Nott'm Forest", gw));
  }
  const dataset = buildDataset({ csv: syntheticCsv({ absent }), season: 'leak-pin' });
  const index = buildAvailabilityIndex(dataset, records);

  for (let gw = 1; gw <= GWS; gw++) {
    const state = index.stateFor(22, gw);
    const boundary = leakageBoundaryMs(dataset, gw);
    if (!state) continue;
    // The run counts fixtures he has already missed. Every one of them has to
    // have kicked off before the boundary, so the run can never include this
    // gameweek or any later one. A rule that admitted the current gameweek
    // would make the run one longer than this.
    assert.equal(state.run, gw - 4, `gameweek ${gw} run`);
    const newestUsed = Date.parse(state.newsAdded);
    assert.ok(newestUsed < boundary, `gameweek ${gw}: read a record at or after its own boundary`);
    assert.ok(newestUsed <= Date.parse(kickoffFor(gw - 1)), `gameweek ${gw}: read beyond the previous gameweek`);
  }
});

test('a player who plays while listed is available, and the listing is ignored', () => {
  // Listed for gameweeks 2 and 3, but he played both.
  const records = [
    record('Michael Obafemi', "Nott'm Forest", 2, 'Questionable', 'Knock'),
    record('Michael Obafemi', "Nott'm Forest", 3, 'Questionable', 'Knock'),
  ];
  const index = buildAvailabilityIndex(DATASET, records);
  assert.equal(index.stateFor(22, 3), null, 'he played in gameweek 2, so there is no doubt');
  assert.equal(index.stateFor(22, 4), null, 'and none after gameweek 3 either');
});

test('a longer spell is a lower chance of playing than a fresh one', () => {
  const absent = new Set();
  const records = [];
  for (let gw = 2; gw <= GWS; gw++) {
    absent.add(`22:${gw}`);
    records.push(record('Michael Obafemi', "Nott'm Forest", gw));
  }
  const dataset = buildDataset({ csv: syntheticCsv({ absent }), season: 'spell' });
  const index = buildAvailabilityIndex(dataset, records);

  const fresh = index.stateFor(22, 3);
  const long = index.stateFor(22, GWS);
  assert.equal(fresh.run, 1);
  assert.ok(long.run >= 5);
  assert.ok(long.chanceNext < fresh.chanceNext, `${long.chanceNext} should be under ${fresh.chanceNext}`);
  for (const state of [fresh, long]) {
    assert.ok(state.chanceNext >= AVAILABILITY_PARAMS.minAvailability - 1e-12);
    assert.ok(state.chanceNext <= AVAILABILITY_PARAMS.maxAvailability + 1e-12);
  }
});

test('the index is immutable across gameweeks, so replaying it twice gives identical answers', () => {
  const absent = new Set();
  const records = [];
  for (let gw = 3; gw <= GWS; gw++) {
    absent.add(`11:${gw}`);
    records.push(record('R. Hojlund', 'Manchester United', gw));
  }
  const dataset = buildDataset({ csv: syntheticCsv({ absent }), season: 'immutable' });
  const index = buildAvailabilityIndex(dataset, records);

  const forwards = [];
  for (let gw = 1; gw <= GWS; gw++) forwards.push(index.stateFor(11, gw));
  const backwards = [];
  for (let gw = GWS; gw >= 1; gw--) backwards.unshift(index.stateFor(11, gw));
  assert.deepEqual(forwards, backwards, 'reading in reverse must not change an answer');
});

// --- the game state --------------------------------------------------------

test('with no availability index the replay reports every player fit, exactly as before', () => {
  const accumulator = createAccumulator(DATASET, {});
  const state = gameStateAt(DATASET, 5, { rules: RULES, accumulator });
  for (const player of state.players.values()) {
    assert.equal(player.status, 'a');
    assert.equal(player.chanceNext, null);
    assert.equal(player.news, '');
  }
});

test('with one, the flagged player carries a doubt and everybody else is untouched', () => {
  const absent = new Set();
  const records = [];
  for (let gw = 2; gw <= GWS; gw++) {
    absent.add(`22:${gw}`);
    records.push(record('Michael Obafemi', "Nott'm Forest", gw, 'Missing Fixture', 'Thigh Injury'));
  }
  const dataset = buildDataset({ csv: syntheticCsv({ absent }), season: 'state' });
  const index = buildAvailabilityIndex(dataset, records);
  const accumulator = createAccumulator(dataset, {});
  const state = gameStateAt(dataset, 5, { rules: RULES, accumulator, availability: index });

  const flagged = state.players.get(22);
  assert.equal(flagged.status, 'd');
  assert.ok(flagged.chanceNext > 0 && flagged.chanceNext < 1);
  assert.match(flagged.news, /Thigh Injury/);

  for (const [id, player] of state.players) {
    if (id === 22) continue;
    assert.equal(player.status, 'a', `player ${id} should be untouched`);
    assert.equal(player.chanceNext, null);
  }
});

test('a player the join could not place falls back to fit, never to unavailable', () => {
  const absent = new Set();
  const records = [];
  for (let gw = 2; gw <= GWS; gw++) {
    absent.add(`22:${gw}`);
    // A name no player in the club answers to.
    records.push(record('Casemiro', "Nott'm Forest", gw));
  }
  const dataset = buildDataset({ csv: syntheticCsv({ absent }), season: 'unmatched' });
  const index = buildAvailabilityIndex(dataset, records);
  const accumulator = createAccumulator(dataset, {});
  const state = gameStateAt(dataset, 5, { rules: RULES, accumulator, availability: index });

  assert.equal(index.stats.matchedNames, 0);
  assert.equal(state.players.get(22).status, 'a');
  assert.equal(state.players.get(22).chanceNext, null);
});
