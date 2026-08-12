import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameState } from '../js/engine/normalize.js';
import { assembleSampleBundle, expandTable, isDemoRequested } from '../js/data/sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const bootstrap = read('fixtures', 'bootstrap.json');
const fixtures = read('fixtures', 'fixtures.json');
const eventsInSeason = read('fixtures', 'events-in-season.json');

const FETCHED = '2026-08-10T12:00:00Z';
const state = buildGameState(bootstrap, fixtures, { fetchedAt: FETCHED });

// ---------------------------------------------------------------- world -----

test('the normalized world carries teams, players, fixtures and events', () => {
  assert.equal(state.teams.size, 20);
  assert.equal(state.players.size, bootstrap.elements.length);
  assert.equal(state.fixtures.length, fixtures.length);
  assert.equal(state.events.length, 38);
  assert.equal(state.fetchedAt, FETCHED);
  assert.equal(state.rules.squadSize, 15, 'rules travel with the game state');
});

test('teams keep the only strength signal that is populated pre-season', () => {
  const arsenal = state.teams.get(1);
  assert.equal(arsenal.name, 'Arsenal');
  assert.equal(arsenal.shortName, 'ARS');
  // SPEC: strength_attack_* / strength_defence_* are all 0 and `strength` is
  // null before the season starts, so only these two are worth carrying.
  assert.ok(arsenal.strengthOverallHome >= 1 && arsenal.strengthOverallHome <= 5);
  assert.ok(arsenal.strengthOverallAway >= 1 && arsenal.strengthOverallAway <= 5);
});

// ---------------------------------------------------------------- players ---

test('every string-valued numeric field is parsed to a float exactly once', () => {
  // FPL ships expected_goals as "0.07" and selected_by_percent as "31.0".
  // A single un-parsed field turns a projection into string concatenation.
  for (const p of state.players.values()) {
    for (const key of ['xG', 'xA', 'xGI', 'xGC', 'selectedByPercent']) {
      assert.equal(typeof p[key], 'number', `${p.webName}.${key}`);
      assert.equal(Number.isFinite(p[key]), true, `${p.webName}.${key}`);
    }
    for (const key of Object.keys(p.per90)) {
      assert.equal(typeof p.per90[key], 'number', `${p.webName}.per90.${key}`);
    }
  }
  const withXg = [...state.players.values()].find(p => p.xG > 0);
  assert.ok(withXg, 'the fixture roster must include a player with real xG');
});

test('a player is renamed into the shared shape', () => {
  const raw = bootstrap.elements.find(e => e.element_type === 3 && e.minutes > 1000);
  const p = state.players.get(raw.id);
  assert.equal(p.webName, raw.web_name);
  assert.equal(p.teamId, raw.team);
  assert.equal(p.position, raw.element_type);
  assert.equal(p.nowCost, raw.now_cost);
  assert.equal(p.costChangeStart, raw.cost_change_start);
  assert.equal(p.cbit, raw.clearances_blocks_interceptions);
  assert.equal(p.defCon, raw.defensive_contribution);
  assert.equal(p.per90.defCon, raw.defensive_contribution_per_90);
});

test('availability is normalized to a probability, and set-piece duty to null when absent', () => {
  const doubtful = [...state.players.values()].find(p => p.status === 'd' && p.chanceNext !== null);
  assert.ok(doubtful, 'the fixture roster must include a doubtful player');
  assert.ok(doubtful.chanceNext >= 0 && doubtful.chanceNext <= 1, 'a percentage became a probability');
  assert.equal(doubtful.chanceNext, doubtful.chanceNext, 'no NaN');

  const injured = [...state.players.values()].filter(p => p.status === 'i');
  assert.ok(injured.length >= 1, 'the fixture roster must include an injured player');
  assert.ok(injured.every(p => p.news.length > 0), 'an injured player carries the news text that explains it');

  const healthy = [...state.players.values()].find(p => p.status === 'a' && p.chanceNext === null);
  assert.equal(healthy.chanceNext, null, 'no chance data must stay null, never 0');

  for (const p of state.players.values()) {
    const sp = p.setPieces;
    for (const key of ['penaltiesOrder', 'directFreekicksOrder', 'cornersOrder']) {
      assert.ok(sp[key] === null || Number.isInteger(sp[key]), `${p.webName}.${key}`);
    }
  }
});

test('promoted-club players are present and carry no Premier League history', () => {
  // SPEC: Coventry (7), Hull (11) and Ipswich (12) are promoted, so any model
  // that treats zero minutes as "bad player" rather than "no data" is wrong.
  const promoted = [...state.players.values()].filter(p => [7, 11, 12].includes(p.teamId));
  assert.ok(promoted.length >= 3, 'fixtures must include promoted-club players');
  assert.ok(promoted.some(p => p.minutes === 0 && p.starts === 0));
});

// ---------------------------------------------------------------- events ----

test('pre-season is a valid state, not an error', () => {
  // Today: no event carries is_current, so there is no current gameweek. The
  // app must route to pre-season mode rather than treat this as a failure.
  assert.equal(state.currentEvent, null);
  assert.equal(state.nextEvent, 1);
  assert.equal(state.seasonStarted, false);
  assert.equal(state.events[0].deadline, bootstrap.events[0].deadline_time);
  assert.equal(typeof state.events[0].deadlineEpoch, 'number');
});

test('once a gameweek is current the same code reports an in-season state', () => {
  const inSeason = buildGameState({ ...bootstrap, events: eventsInSeason }, fixtures, { fetchedAt: FETCHED });
  assert.equal(inSeason.currentEvent, 5);
  assert.equal(inSeason.nextEvent, 6);
  assert.equal(inSeason.seasonStarted, true);
  assert.equal(inSeason.events.filter(e => e.finished).length, 5);
});

test('a finished season with no current or next event is still not an error', () => {
  const over = bootstrap.events.map(e => ({ ...e, finished: true, is_current: false, is_next: false, is_previous: e.id === 38 }));
  const done = buildGameState({ ...bootstrap, events: over }, fixtures, { fetchedAt: FETCHED });
  assert.equal(done.currentEvent, null);
  assert.equal(done.nextEvent, null);
  assert.equal(done.seasonStarted, true);
});

// ---------------------------------------------------------------- fixtures --

test('blanks and doubles are derivable from fixture counts, never hardcoded', () => {
  const countFor = (teamId, gw) => state.fixtures
    .filter(f => f.event === gw && (f.teamH === teamId || f.teamA === teamId)).length;

  const gw5 = state.fixtures.filter(f => f.event === 5);
  const gw6 = state.fixtures.filter(f => f.event === 6);
  assert.equal(gw5.length, 9, 'the blank gameweek is short one fixture');
  assert.equal(gw6.length, 11, 'which turns up in the double');

  const blanked = [...state.teams.keys()].filter(id => countFor(id, 5) === 0);
  const doubled = [...state.teams.keys()].filter(id => countFor(id, 6) === 2);
  assert.equal(blanked.length, 2);
  assert.deepEqual(blanked, doubled, 'the same two clubs blank in GW5 and double in GW6');
  assert.equal([...state.teams.keys()].every(id => countFor(id, 1) === 1), true, 'a normal gameweek is one each');
});

test('finished fixtures carry scores and unplayed ones carry null', () => {
  const played = state.fixtures.filter(f => f.finished);
  const upcoming = state.fixtures.filter(f => !f.finished);
  assert.ok(played.length > 0 && upcoming.length > 0);
  for (const f of played) {
    assert.equal(typeof f.teamHScore, 'number');
    assert.equal(typeof f.teamAScore, 'number');
  }
  for (const f of upcoming) {
    assert.equal(f.teamHScore, null);
    assert.equal(f.teamAScore, null);
    assert.ok(f.teamHDifficulty >= 1 && f.teamHDifficulty <= 5, 'FDR is populated even pre-season');
  }
});

// ---------------------------------------------------------------- sample ----

const sampleFiles = {
  meta: read('..', 'data', 'sample', 'meta.json'),
  bootstrap: read('..', 'data', 'sample', 'bootstrap.json'),
  fixtures: read('..', 'data', 'sample', 'fixtures.json'),
  entry: read('..', 'data', 'sample', 'entry.json'),
  'entry-history': read('..', 'data', 'sample', 'entry-history.json'),
  'entry-transfers': read('..', 'data', 'sample', 'entry-transfers.json'),
  'entry-picks': read('..', 'data', 'sample', 'entry-picks.json'),
};
const sample = assembleSampleBundle(sampleFiles);

test('the column-table encoding round-trips to the upstream shape', () => {
  const table = { fields: ['id', 'web_name'], rows: [[1, 'Raya'], [2, 'Salah']] };
  assert.deepEqual(expandTable(table), [{ id: 1, web_name: 'Raya' }, { id: 2, web_name: 'Salah' }]);
  assert.deepEqual(expandTable(null), []);
  assert.equal(sample.bootstrap.elements.length, sampleFiles.bootstrap.elementsTable.rows.length);
  assert.equal(sample.bootstrap.elements[0].web_name, sampleFiles.bootstrap.elementsTable.rows[0][2]);
});

test('the sample dataset is labelled as sample data everywhere a consumer can look', () => {
  assert.equal(sample.sample, true);
  assert.equal(sample.bootstrap.sample, true);
  assert.equal(sample.entry.sample, true);
  assert.equal(sample.history.sample, true);
  assert.equal(sample.picks.sample, true);
  assert.equal(sample.meta.sample, true);
  assert.match(sample.entry.name, /sample|demo/i, 'even the team name says so');
  assert.equal(isDemoRequested('?demo=1'), true);
  assert.equal(isDemoRequested('?demo=0'), false);
  assert.equal(isDemoRequested(''), false);
});

test('the sample dataset exercises the in-season state that cannot exist yet', () => {
  const s = buildGameState(sample.bootstrap, sample.fixtures, { fetchedAt: sample.fetchedAt });
  assert.equal(s.seasonStarted, true);
  assert.equal(s.currentEvent, 12);
  assert.equal(s.nextEvent, 13);
  assert.equal(s.teams.size, 20);
  assert.ok(s.players.size >= 300, `optimizer needs real choices, got ${s.players.size}`);
  assert.equal(s.fixtures.length, 380);
  assert.ok(s.fixtures.filter(f => f.finished).length >= 120, 'twelve gameweeks of results');

  const countFor = (teamId, gw) => s.fixtures.filter(f => f.event === gw && (f.teamH === teamId || f.teamA === teamId)).length;
  const blanked = [...s.teams.keys()].filter(id => countFor(id, sample.meta.blankGameweek) === 0);
  const doubled = [...s.teams.keys()].filter(id => countFor(id, sample.meta.doubleGameweek) === 2);
  assert.equal(blanked.length, 4);
  assert.deepEqual(blanked, doubled);
  // Both sit inside the default 5-gameweek horizon from the planning gameweek,
  // so the planner actually has to handle them.
  assert.ok(sample.meta.blankGameweek < sample.planEvent + 5);

  const moved = [...s.players.values()].filter(p => p.costChangeStart !== 0);
  assert.ok(moved.length > 50, 'a real market has moved by GW12');
  assert.ok([...s.players.values()].some(p => p.status === 'i'), 'and someone is injured');
});

test('the sample bundle answers on the same paths as the live client', () => {
  const id = sample.entryId;
  assert.ok(sample.byPath['bootstrap-static']);
  assert.ok(sample.byPath.fixtures);
  assert.ok(sample.byPath[`entry/${id}`]);
  assert.ok(sample.byPath[`entry/${id}/history`]);
  assert.ok(sample.byPath[`entry/${id}/transfers`]);
  assert.ok(sample.byPath[`entry/${id}/event/${sample.currentEvent}/picks`]);
});
