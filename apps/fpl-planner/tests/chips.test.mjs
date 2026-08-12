// chips.js - chip strategy across the remaining season, SPEC 12 and the
// brief's sections 23 to 28.
//
// The chip decisions are all comparisons: this week against every other week
// the chip is legal in, and the chip against doing nothing. Hand-written
// projections are what make those comparisons assertable, so the worlds below
// are built to say exactly one thing each: the bench is strong NOW, the double
// is LATER, the squad blanks THIS week.
//
// Every threshold is read from the module's own exported CHIP_PARAMS rather
// than retyped, so a deliberate change to a threshold moves the tests with it
// and an accidental one still fails them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules, chipAvailableAt } from '../js/engine/rules.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { validatePlan } from '../js/engine/validate.js';
import { buildPlan } from '../js/engine/planner.js';
import { assembleSampleBundle } from '../js/data/sample.js';
import {
  evaluateChips, squadTrajectory, discountWeights, chipLabel, fmtValue, makeReason, CHIP_PARAMS, xpOf,
} from '../js/engine/chips.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const RULES = buildRules(read('fixtures', 'bootstrap.json'));

// ---------------------------------------------------------------------------
// A 16-club world. Each club fields a goalkeeper, two defenders, two
// midfielders and a forward, which is the smallest league that can still fill a
// legal 15 twice over under a three-per-club limit.
// ---------------------------------------------------------------------------

const CLUBS = 16;
const PRICE = { 1: 45, 2: 45, 3: 60, 4: 70 };

function makeRoster() {
  const players = [];
  for (let club = 1; club <= CLUBS; club++) {
    const shape = [[1, 1], [2, 2], [3, 2], [4, 1]];
    let n = 0;
    for (const [position, count] of shape) {
      for (let i = 0; i < count; i++) {
        const id = club * 100 + (++n);
        players.push({
          id,
          code: id,
          webName: `C${club}P${n}`,
          firstName: '',
          secondName: `C${club}P${n}`,
          teamId: club,
          position,
          nowCost: PRICE[position],
          status: 'a',
          chanceNext: null,
          news: '',
          newsAdded: null,
          selectedByPercent: 5,
          minutes: 2000,
          starts: 25,
          totalPoints: 100,
          bonus: 5,
          bps: 300,
          saves: 0,
          goalsScored: 5,
          assists: 5,
          cleanSheets: 5,
          goalsConceded: 20,
          yellowCards: 2,
          redCards: 0,
          ownGoals: 0,
          penaltiesSaved: 0,
          penaltiesMissed: 0,
          cbit: 50,
          recoveries: 100,
          tackles: 30,
          defCon: 180,
          xG: 5,
          xA: 5,
          xGI: 10,
          xGC: 20,
          per90: { xG: 0.2, xA: 0.2, xGI: 0.4, xGC: 1, saves: 0, goalsConceded: 1, starts: 1, cleanSheets: 0.2, defCon: 8 },
          setPieces: { penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null },
        });
      }
    }
  }
  return players;
}

const ROSTER = makeRoster();
const byClubPos = (club, position) => ROSTER.filter(p => p.teamId === club && p.position === position).map(p => p.id);

// 15 players over seven clubs, three at most from any one of them.
const SQUAD = [
  ...byClubPos(1, 1), ...byClubPos(2, 1),
  ...byClubPos(1, 2), ...byClubPos(2, 2).slice(0, 1), ...byClubPos(3, 2),
  ...byClubPos(3, 3).slice(0, 1), ...byClubPos(4, 3), ...byClubPos(5, 3),
  ...byClubPos(5, 4), ...byClubPos(6, 4), ...byClubPos(7, 4),
];

const SQUAD_CLUBS = [1, 2, 3, 4, 5, 6, 7];

// The eleven the lineup optimizer will pick when these are the good players
// (one keeper, four defenders, four midfielders, two forwards), and the four it
// will bench. Splitting by position rather than by squad order matters: a
// "first eleven" that contains two goalkeepers cannot be fielded, and the
// optimizer would bench a good player instead of the one the test meant.
const STRONG_XI = [SQUAD[0], SQUAD[2], SQUAD[3], SQUAD[4], SQUAD[5], SQUAD[7], SQUAD[8], SQUAD[9], SQUAD[10], SQUAD[12], SQUAD[13]];
const BENCH_FOUR = SQUAD.filter(id => !STRONG_XI.includes(id));

// `blanks` lists clubs with no fixture that gameweek, `doubles` lists clubs with
// two. Everything else plays once.
function makeFixtures({ gwTo, blanks = {}, doubles = {} }) {
  const out = [];
  let id = 1;
  const add = (gw, home, away, suffix) => out.push({
    id: id++,
    code: id,
    event: gw,
    kickoff: `2026-01-0${(gw % 9) + 1}T1${suffix}:00:00Z`,
    teamH: home,
    teamA: away,
    teamHDifficulty: 3,
    teamADifficulty: 3,
    finished: false,
    started: false,
    teamHScore: null,
    teamAScore: null,
  });

  for (let gw = 1; gw <= gwTo; gw++) {
    const blank = new Set(blanks[gw] || []);
    const playing = [];
    for (let club = 1; club <= CLUBS; club++) if (!blank.has(club)) playing.push(club);
    for (let i = 0; i + 1 < playing.length; i += 2) add(gw, playing[i], playing[i + 1], 5);
    for (const club of doubles[gw] || []) {
      add(gw, club, club === CLUBS ? 1 : club + 1, 8);
    }
  }
  return out;
}

function makeGameState(fixtures, gw, players = ROSTER) {
  const teams = new Map();
  for (let club = 1; club <= CLUBS; club++) {
    teams.set(club, { id: club, code: club, name: `Club ${club}`, shortName: `C${club}`, strengthOverallHome: 3, strengthOverallAway: 3 });
  }
  const events = [];
  for (let i = 1; i <= RULES.totalEvents; i++) {
    events.push({
      id: i, name: `Gameweek ${i}`, deadline: null, deadlineEpoch: null,
      finished: i < gw, dataChecked: i < gw, isCurrent: i === gw - 1, isNext: i === gw, isPrevious: i === gw - 2,
      averageEntryScore: null, highestScore: null,
    });
  }
  return {
    rules: RULES,
    teams,
    players: new Map(players.map(p => [p.id, p])),
    fixtures,
    events,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    currentEvent: gw - 1,
    nextEvent: gw,
    seasonStarted: true,
  };
}

// A double gameweek is worth the sum over its fixtures, which is what makes a
// bench boost or a triple captain week worth waiting for.
function makeProjections(gameState, gwFrom, gwTo, xp, pAppearOf = () => 1) {
  const byPlayer = new Map();
  for (const p of gameState.players.values()) {
    const rows = [];
    for (let gw = gwFrom; gw <= gwTo; gw++) {
      const fixtures = gameState.fixtures.filter(f => f.event === gw && (f.teamH === p.teamId || f.teamA === p.teamId));
      const pAppear = fixtures.length ? pAppearOf(p.id, gw) : 0;
      const points = fixtures.length * xp(p.id, gw) * pAppear;
      rows.push({
        playerId: p.id,
        gw,
        fixtures: fixtures.map(f => ({
          fixtureId: f.id,
          opponentId: f.teamH === p.teamId ? f.teamA : f.teamH,
          isHome: f.teamH === p.teamId,
          fdr: 3,
          kickoff: f.kickoff,
        })),
        pAppear,
        pStart: pAppear,
        xMins: pAppear * 90,
        components: {
          xGoals: 0, xAssists: 0, xCleanSheet: 0, xSaves: 0, xBonus: 0,
          xCards: 0, xDefCon: 0, xConceded: 0, xPensSaved: 0,
        },
        xPoints: points,
        sd: 1,
        ceiling: Math.round(points + 3),
        confidence: 'high',
      });
    }
    byPlayer.set(p.id, rows);
  }
  return {
    gwFrom,
    gwTo,
    byPlayer,
    modelVersion: 'synthetic-1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    dataFetchedAt: '2026-01-01T00:00:00.000Z',
    get(playerId, gw) {
      const rows = byPlayer.get(playerId);
      if (!rows) return null;
      const i = gw - gwFrom;
      return i >= 0 && i < rows.length ? rows[i] : null;
    },
  };
}

function makeSquadState({ gw, bankTenths = 20, freeTransfers = 1, chipsUsed = [], picks = SQUAD }) {
  const priceOf = id => ROSTER.find(p => p.id === id).nowCost;
  return {
    entryId: 42,
    entryName: 'Test XI',
    managerName: 'Test Manager',
    gw,
    picks: picks.map((playerId, i) => ({
      playerId,
      slot: i + 1,
      isCaptain: false,
      isViceCaptain: false,
      multiplier: i < RULES.starters ? 1 : 0,
      purchaseTenths: priceOf(playerId),
      sellingTenths: priceOf(playerId),
    })),
    bankTenths,
    squadValueTenths: picks.reduce((s, id) => s + priceOf(id), 0) + bankTenths,
    freeTransfers,
    chipsUsed,
    chipsAvailable: [],
    overallRank: 250000,
    totalPoints: 500,
    source: 'picks',
    asOf: '2026-01-01T00:00:00.000Z',
    warnings: [],
  };
}

function scenario({ gw, xp, horizon = 5, discount = 0.85, blanks = {}, doubles = {}, chipsUsed = [], bankTenths = 20, pAppearOf }) {
  const fixtures = makeFixtures({ gwTo: RULES.totalEvents, blanks, doubles });
  const gameState = makeGameState(fixtures, gw);
  const projections = makeProjections(gameState, gw, gw + Math.max(horizon, 5) + 4, xp, pAppearOf);
  const squadState = makeSquadState({ gw, chipsUsed, bankTenths });
  const evaluation = evaluateChips({ squadState, projections, gameState, rules: RULES, horizon, discount });
  return { gameState, projections, squadState, evaluation, horizon, discount };
}

const flat = () => 5;
// A settled eleven, a bench nobody would pay four points to boost, and a market
// no better than what is already owned.
const ordinaryWeek = id => (STRONG_XI.includes(id) ? 6 : BENCH_FOUR.includes(id) ? 1.5 : 3);
const reasonOf = (entry, code) => entry.reasons.find(r => r.code === code);

// ---------------------------------------------------------------------------
// Windows: which chips are legal at all
// ---------------------------------------------------------------------------

test('the catalogue carries each chip twice, once per half of the season', () => {
  const names = [...new Set(RULES.chips.map(c => c.name))].sort();
  assert.deepEqual(names, ['3xc', 'bboost', 'freehit', 'wildcard']);
  for (const name of names) {
    assert.equal(RULES.chips.filter(c => c.name === name).length, 2, `${name} has two windows`);
  }
});

test('in gameweek 1 the wildcard and the free hit are not playable and the bench boost and triple captain are', () => {
  assert.equal(chipAvailableAt(RULES, 'wildcard', 1, []), false);
  assert.equal(chipAvailableAt(RULES, 'freehit', 1, []), false);
  assert.equal(chipAvailableAt(RULES, 'bboost', 1, []), true);
  assert.equal(chipAvailableAt(RULES, '3xc', 1, []), true);

  const { evaluation } = scenario({ gw: 1, xp: flat });

  for (const chip of ['wildcard', 'freehit']) {
    const entry = evaluation.perChip[chip];
    assert.equal(entry.available, false, `${chip} must not be evaluated as playable in gameweek 1`);
    assert.equal(entry.recommended, false);
    assert.equal(entry.nextLegalGw, 2, `${chip} opens in gameweek 2`);
    assert.deepEqual(entry.detail, {});
    const reason = reasonOf(entry, 'chip_window');
    assert.ok(reason, 'an unplayable chip explains itself');
    assert.equal(reason.value, 2);
    assert.ok(reason.text.includes('2'));
  }
  assert.equal(evaluation.perChip.bboost.available, true);
  assert.equal(evaluation.perChip['3xc'].available, true);
  assert.notEqual(evaluation.recommendation.chip, 'wildcard');
  assert.notEqual(evaluation.recommendation.chip, 'freehit');
});

test('a chip played in the first half comes back in the second and is never offered in between', () => {
  const used = [{ name: 'bboost', event: 5 }];
  assert.equal(chipAvailableAt(RULES, 'bboost', 10, used), false);
  assert.equal(chipAvailableAt(RULES, 'bboost', 25, used), true);

  const first = scenario({ gw: 10, xp: flat, chipsUsed: used });
  assert.equal(first.evaluation.perChip.bboost.available, false);
  assert.equal(first.evaluation.perChip.bboost.recommended, false);
  assert.equal(first.evaluation.perChip.bboost.nextLegalGw, 20, 'the second bench boost window opens at gameweek 20');
  assert.equal(reasonOf(first.evaluation.perChip.bboost, 'chip_window').value, 20);

  const second = scenario({ gw: 25, xp: flat, chipsUsed: used });
  assert.equal(second.evaluation.perChip.bboost.available, true);
});

test('the whole 38 gameweek availability curve of a chip is walked, not sampled', () => {
  // Sampling two gameweeks either side of a boundary is what a snapshot test
  // does, and it cannot see an off-by-one at the edge of a window. This walks
  // every gameweek of the season and asserts the exact shape.
  const [firstHalf, secondHalf] = RULES.chips
    .filter(c => c.name === 'wildcard')
    .slice()
    .sort((a, b) => a.startEvent - b.startEvent);
  assert.equal(firstHalf.startEvent, 2);
  assert.equal(firstHalf.stopEvent, 19);
  assert.equal(secondHalf.startEvent, 20);
  assert.equal(secondHalf.stopEvent, RULES.totalEvents);

  const curve = (used) => {
    const out = [];
    for (let gw = 1; gw <= RULES.totalEvents; gw++) out.push(chipAvailableAt(RULES, 'wildcard', gw, used) ? 1 : 0);
    return out.join('');
  };

  const never = curve([]);
  assert.equal(never[0], '0', 'gameweek 1 is before the first window opens');
  assert.equal(never.slice(1), '1'.repeat(RULES.totalEvents - 1), 'and it is playable in every gameweek after that');

  // Played in gameweek 8: gone for the rest of the first half, back the moment
  // the second window opens, and back on gameweek 20 exactly rather than 19 or 21.
  const usedEarly = curve([{ name: 'wildcard', event: 8 }]);
  assert.equal(usedEarly.slice(0, 19), '0'.repeat(19), 'unavailable through gameweek 19');
  assert.equal(usedEarly.slice(19), '1'.repeat(RULES.totalEvents - 19), 'available from gameweek 20');

  // Played on the last gameweek of the first window, which is the edge case an
  // off-by-one lands on.
  const usedAtEdge = curve([{ name: 'wildcard', event: 19 }]);
  assert.equal(usedAtEdge[18], '0', 'gameweek 19 itself is spent');
  assert.equal(usedAtEdge[19], '1', 'gameweek 20 is the refresh');

  // Played on the first gameweek of the second window: the first half is
  // untouched by it, the rest of the season is gone.
  const usedLate = curve([{ name: 'wildcard', event: 20 }]);
  assert.equal(usedLate.slice(1, 19), '1'.repeat(18), 'the first half window is a different chip');
  assert.equal(usedLate.slice(19), '0'.repeat(RULES.totalEvents - 19));

  // Both spent: nothing left anywhere.
  assert.equal(curve([{ name: 'wildcard', event: 8 }, { name: 'wildcard', event: 30 }]), '0'.repeat(RULES.totalEvents));
});

test('an unused first-half chip does not accumulate into the second half', () => {
  // Two windows means two chips, one per half. Never playing the first one does
  // not hand the manager two in the second half, and the evaluator must not
  // offer it twice after gameweek 20.
  const used = [{ name: 'bboost', event: 25 }];
  for (let gw = 20; gw <= RULES.totalEvents; gw++) {
    assert.equal(chipAvailableAt(RULES, 'bboost', gw, used), false, `gameweek ${gw} after the second-half chip is spent`);
  }
});

test('a chip spent in both halves is gone for the season', () => {
  const used = [{ name: '3xc', event: 5 }, { name: '3xc', event: 22 }];
  const { evaluation } = scenario({ gw: 25, xp: flat, chipsUsed: used });
  const entry = evaluation.perChip['3xc'];
  assert.equal(entry.available, false);
  assert.equal(entry.recommended, false);
  assert.equal(entry.nextLegalGw, null);
  assert.ok(reasonOf(entry, 'chip_spent'), 'a spent chip says it is spent, not that it is coming back');
  assert.equal(reasonOf(entry, 'chip_window'), undefined);
});

test('an unavailable chip is never the recommendation, whatever it would have been worth', () => {
  // A monstrous bench in a double gameweek, with both bench boosts already
  // spent. The value is real and the answer is still no.
  const used = [{ name: 'bboost', event: 3 }, { name: 'bboost', event: 21 }];
  const { evaluation } = scenario({
    gw: 25, xp: flat, doubles: { 25: SQUAD_CLUBS }, chipsUsed: used,
  });
  assert.equal(evaluation.perChip.bboost.available, false);
  assert.equal(evaluation.perChip.bboost.valueNow, 0);
  assert.notEqual(evaluation.recommendation.chip, 'bboost');
});

// ---------------------------------------------------------------------------
// Hold, the common answer
// ---------------------------------------------------------------------------

test('hold comes back with real numbers when no chip clears its bar', () => {
  // An ordinary week: a settled eleven, a thin bench (which is what a bench
  // looks like when the money is in the eleven), an unremarkable market and no
  // double or blank anywhere. None of the four chips has anything to bite on.
  const { evaluation } = scenario({ gw: 10, xp: ordinaryWeek });
  const rec = evaluation.recommendation;

  assert.equal(rec.decision, 'hold');
  assert.equal(rec.chip, null);
  assert.ok(rec.reasons.length >= 2, 'holding is explained, not left as an empty state');

  const inHand = reasonOf({ reasons: rec.reasons }, 'chips_in_hand');
  const available = Object.values(evaluation.perChip).filter(c => c.available);
  assert.equal(inHand.value, available.length);
  assert.equal(inHand.text, `You have ${available.length} chips playable this gameweek, and none of them clears its bar.`);

  for (const entry of available) {
    const held = rec.reasons.find(r => r.code === `hold_${entry.chip}`);
    assert.ok(held, `${entry.chip} explains why it is being held`);
    assert.equal(held.value, entry.valueNow);
    assert.ok(held.text.includes(fmtValue(entry.valueNow, 'points')));
    assert.ok(held.text.includes(fmtValue(entry.threshold, 'points')), 'the bar it fell short of is named');
  }

  // The bar each chip is measured against is its own, and the sentence has to
  // state the right one. The triple captain's bar is a MARGIN over the best
  // week left, so "worth 6.0 points, short of the 2.5 it needs" would be a
  // false sentence built out of two true numbers.
  const tc = evaluation.perChip['3xc'];
  assert.ok(tc.valueNow > tc.threshold, 'the scenario only bites if the value is above the bare margin');
  const tcReason = rec.reasons.find(r => r.code === 'hold_3xc');
  assert.ok(
    tcReason.text.includes(fmtValue(tc.bestValue, 'points')),
    `the triple captain sentence names the week it is being kept for: ${tcReason.text}`,
  );
  assert.ok(!/short of the 2\.5/.test(tcReason.text), `a margin is not a bar: ${tcReason.text}`);
});

test('the sample dataset holds its chips, with the reason the live run reported', () => {
  const SAMPLE_FILES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const bundle = assembleSampleBundle(Object.fromEntries(
    SAMPLE_FILES.map(name => [name, read('..', 'data', 'sample', `${name}.json`)]),
  ));
  const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  const squadState = buildSquadState({
    entry: bundle.entry, history: bundle.history, transfers: bundle.transfers, picks: bundle.picks,
    gameState, gw: bundle.planEvent,
  });

  // The sample manager has already played a wildcard and a bench boost, so two
  // chips are in hand in the gameweek being planned.
  assert.deepEqual(squadState.chipsAvailable.sort(), ['3xc', 'freehit']);

  const strength = buildStrength(gameState, { asOfGw: squadState.gw });
  const evaluation = evaluateChips({
    squadState,
    projections: buildProjections({ gameState, strength, gwFrom: squadState.gw, gwTo: squadState.gw + 4 }),
    gameState,
    rules: gameState.rules,
    horizon: 5,
    discount: 0.85,
  });
  assert.equal(evaluation.recommendation.decision, 'hold');
  assert.equal(evaluation.recommendation.chip, null);
  assert.equal(
    evaluation.recommendation.reasons[0].text,
    'You have 2 chips playable this gameweek, and none of them clears its bar.',
  );
  assert.equal(evaluation.perChip.wildcard.available, false, 'the wildcard was spent in the first half');
  assert.equal(evaluation.perChip.bboost.available, false);
});

test('a squad that does not exist yet holds every chip', () => {
  const fixtures = makeFixtures({ gwTo: RULES.totalEvents });
  const gameState = makeGameState(fixtures, 1);
  const projections = makeProjections(gameState, 1, 6, flat);
  const evaluation = evaluateChips({
    squadState: { ...makeSquadState({ gw: 1 }), picks: [] },
    projections,
    gameState,
    rules: RULES,
    horizon: 5,
  });
  assert.equal(evaluation.recommendation.decision, 'hold');
  assert.deepEqual(evaluation.perChip, {});
  assert.equal(evaluation.recommendation.reasons[0].code, 'no_squad');
  assert.equal(evaluation.recommendation.reasons[0].value, 4, 'four chips, counted from the catalogue');
});

// ---------------------------------------------------------------------------
// Bench boost
// ---------------------------------------------------------------------------

test('bench boost values the eleven plus the bench, and fires when the bench is strong in a double gameweek', () => {
  const GW = 10;
  const { evaluation, projections, squadState } = scenario({
    gw: GW, xp: flat, doubles: { [GW]: SQUAD_CLUBS },
  });
  const entry = evaluation.perChip.bboost;

  // The value of the chip is exactly the bench's projection, and the bench is
  // whatever the lineup optimizer left out of the eleven it would have played
  // anyway.
  const first = evaluation.baseline.gws[0];
  const bench = [first.bench.gk, ...first.bench.order];
  const benchPoints = bench.reduce((s, id) => s + xpOf(projections, id, GW), 0);
  assert.equal(entry.valueNow, benchPoints);
  assert.deepEqual(entry.detail.bench.sort(), bench.slice().sort());
  assert.equal(bench.length, 4, 'a bench boost plays four extra players');

  assert.ok(entry.valueNow >= CHIP_PARAMS.benchBoostThreshold);
  assert.ok(entry.valueNow > entry.bestValue, 'this week beats every week left');
  assert.equal(entry.recommended, true);
  assert.equal(evaluation.recommendation.decision, 'play');
  assert.equal(evaluation.recommendation.chip, 'bboost');
  assert.equal(evaluation.recommendation.value, entry.valueNow);

  const gain = reasonOf(entry, 'bboost_value_now');
  assert.equal(gain.value, entry.valueNow);
  assert.equal(reasonOf(entry, 'bboost_threshold').value, CHIP_PARAMS.benchBoostThreshold);
});

test('bench boost waits for the double gameweek instead of firing on an ordinary one', () => {
  const GW = 10;
  const { evaluation } = scenario({ gw: GW, xp: flat, doubles: { [GW + 3]: SQUAD_CLUBS } });
  const entry = evaluation.perChip.bboost;

  assert.ok(entry.valueNow >= CHIP_PARAMS.benchBoostThreshold, 'the bench is good enough in absolute terms');
  assert.equal(entry.bestGw, GW + 3, 'and the double three weeks out is better');
  assert.ok(entry.bestValue > entry.valueNow);
  assert.equal(entry.recommended, false, 'so the chip is held');

  const future = reasonOf(entry, 'bboost_best_future');
  assert.ok(future.text.includes(`gameweek ${GW + 3}`));
  assert.equal(future.value, entry.bestValue);
});

test('a bench of players who will not play is not boostable, and says why', () => {
  const GW = 10;
  // The eleven are nailed on; the four behind them are fringe players who
  // rarely get on the pitch, which is what a real weak bench looks like.
  const strong = new Set(STRONG_XI);
  const { evaluation } = scenario({
    gw: GW,
    xp: id => (strong.has(id) ? 6 : 2),
    pAppearOf: id => (strong.has(id) ? 1 : 0.2),
  });
  const entry = evaluation.perChip.bboost;

  assert.ok(entry.valueNow < CHIP_PARAMS.benchBoostThreshold, `bench worth ${entry.valueNow}`);
  assert.equal(entry.recommended, false);
  assert.equal(entry.detail.weakBench.length, 4);
  const weak = reasonOf(entry, 'bboost_weak_bench');
  assert.equal(weak.value, 4);
  assert.equal(entry.detail.structureCost, (4 - 1) * RULES.hitCost, 'repairing the bench costs transfers, and they are charged');
});

// ---------------------------------------------------------------------------
// Triple captain
// ---------------------------------------------------------------------------

test('triple captain does not fire on the first good fixture', () => {
  const GW = 10;
  const star = SQUAD[7];
  const { evaluation, projections } = scenario({ gw: GW, xp: id => (id === star ? 9 : 4) });
  const entry = evaluation.perChip['3xc'];

  assert.equal(entry.valueNow, xpOf(projections, star, GW), 'the chip is worth exactly one more copy of the captain');
  assert.ok(entry.valueNow > 0);
  // Every remaining week is just as good, so there is no margin in playing it
  // now and the chip is kept.
  assert.ok(entry.valueNow - entry.bestValue < CHIP_PARAMS.tripleCaptainMargin);
  assert.equal(entry.recommended, false);
  assert.equal(reasonOf(entry, '3xc_margin').value, CHIP_PARAMS.tripleCaptainMargin);
  assert.ok(reasonOf(entry, '3xc_best_future'));
});

test('triple captain fires when this week beats every week left by the margin', () => {
  const GW = 10;
  const star = SQUAD[7];
  const starClub = ROSTER.find(p => p.id === star).teamId;
  const { evaluation, projections } = scenario({
    gw: GW, xp: id => (id === star ? 9 : 4), doubles: { [GW]: [starClub] },
  });
  const entry = evaluation.perChip['3xc'];

  assert.equal(entry.valueNow, xpOf(projections, star, GW));
  assert.ok(entry.valueNow - entry.bestValue >= CHIP_PARAMS.tripleCaptainMargin);
  assert.equal(entry.recommended, true);
  assert.equal(evaluation.recommendation.chip, '3xc');
  assert.equal(reasonOf(entry, '3xc_value_now').value, entry.valueNow);
});

test('triple captain finds a double gameweek beyond the projection horizon from the calendar alone', () => {
  const GW = 10;
  const star = SQUAD[7];
  const starClub = ROSTER.find(p => p.id === star).teamId;
  const { evaluation } = scenario({
    gw: GW, horizon: 5, xp: id => (id === star ? 9 : 4), doubles: { [GW + 7]: [starClub] },
  });
  const entry = evaluation.perChip['3xc'];

  assert.equal(entry.bestGw, GW + 7, 'a double two weeks past the horizon is still found');
  assert.equal(entry.detail.bestPlayer, star);
  assert.ok(entry.bestValue > entry.valueNow);
  assert.equal(entry.recommended, false);
});

// ---------------------------------------------------------------------------
// Free hit
// ---------------------------------------------------------------------------

const BLANK_GW = 10;
const AWAY_CLUBS = [9, 10, 11, 12];
const STEADY_CLUBS = [13, 14, 15, 16];
const clubOf = id => ROSTER.find(p => p.id === id).teamId;

test('free hit covers a blank gameweek, and rents a squad for that gameweek alone', () => {
  // The squad's seven clubs all blank. Four other clubs are enormous in this
  // gameweek and useless afterwards; four more are steady all the way through.
  // A one week rental should take the enormous ones, which is precisely the
  // choice a horizon would get wrong.
  const xp = (id) => {
    const club = clubOf(id);
    if (AWAY_CLUBS.includes(club)) return 8;
    if (STEADY_CLUBS.includes(club)) return 4;
    return 5;
  };
  const xpLater = (id, gw) => (gw === BLANK_GW ? xp(id) : (AWAY_CLUBS.includes(clubOf(id)) ? 0.5 : xp(id)));

  const { evaluation, squadState } = scenario({
    gw: BLANK_GW,
    xp: xpLater,
    blanks: { [BLANK_GW]: SQUAD_CLUBS },
  });
  const entry = evaluation.perChip.freehit;

  assert.equal(entry.available, true);
  assert.equal(entry.detail.playableNow, 0, 'not one of the fifteen has a fixture');
  assert.equal(reasonOf(entry, 'freehit_playable').value, 0);
  assert.equal(entry.detail.currentGwPoints, 0, 'and the squad as it stands scores nothing');

  assert.equal(entry.detail.squad.length, RULES.squadSize);
  assert.equal(entry.valueNow, entry.detail.rentedGwPoints - entry.detail.currentGwPoints);
  assert.ok(entry.valueNow >= CHIP_PARAMS.freeHitThreshold, `gain ${entry.valueNow}`);
  assert.equal(entry.recommended, true);
  assert.equal(reasonOf(entry, 'freehit_threshold').value, CHIP_PARAMS.freeHitThreshold);

  // Affordable out of the squad's selling value plus the bank, never out of thin
  // air.
  const spendable = squadState.picks.reduce((s, p) => s + p.sellingTenths, 0) + squadState.bankTenths;
  assert.equal(entry.detail.budgetTenths, spendable);
  assert.ok(entry.detail.costTenths <= spendable);

  // Single gameweek optimization: the rental is loaded with the players who are
  // only good this week.
  const oneWeekWonders = entry.detail.squad.filter(id => AWAY_CLUBS.includes(clubOf(id))).length;
  assert.ok(oneWeekWonders >= 10, `expected the rental to be built from this week's best, got ${oneWeekWonders}`);

  // The wildcard, scored over the whole horizon, does the opposite with the same
  // pool: it will not buy four clubs who stop scoring next week.
  const wildcard = evaluation.perChip.wildcard;
  const wildcardWonders = wildcard.detail.squad.filter(id => AWAY_CLUBS.includes(clubOf(id))).length;
  assert.ok(wildcardWonders < oneWeekWonders, `wildcard took ${wildcardWonders}, free hit took ${oneWeekWonders}`);
});

test('free hit points at the blank gameweek that is coming rather than the ordinary one in front of it', () => {
  const GW = 10;
  const { evaluation } = scenario({
    gw: GW, xp: flat, blanks: { [GW + 2]: SQUAD_CLUBS },
  });
  const entry = evaluation.perChip.freehit;

  assert.equal(entry.detail.playableNow, 15);
  assert.equal(entry.bestGw, GW + 2);
  const reason = reasonOf(entry, 'freehit_future_blank');
  assert.ok(reason.text.includes(`Gameweek ${GW + 2}`));
  assert.equal(reason.value, 0, 'no player has a fixture that week');
  assert.equal(entry.recommended, false, 'nothing is broken this week');
});

// ---------------------------------------------------------------------------
// Wildcard
// ---------------------------------------------------------------------------

test('a wildcard is held when the rebuild does not clear the documented threshold', () => {
  const { evaluation, squadState } = scenario({ gw: 10, xp: flat });
  const entry = evaluation.perChip.wildcard;

  assert.equal(entry.available, true);
  assert.equal(entry.threshold, CHIP_PARAMS.wildcardHorizonThreshold);
  assert.ok(entry.valueNow < CHIP_PARAMS.wildcardHorizonThreshold, `gain ${entry.valueNow}`);
  assert.equal(entry.recommended, false);
  assert.equal(entry.detail.rebuiltHorizon - entry.detail.currentHorizon, entry.valueNow);
  assert.equal(reasonOf(entry, 'wildcard_gain').value, entry.valueNow);
  assert.equal(reasonOf(entry, 'wildcard_threshold').value, CHIP_PARAMS.wildcardHorizonThreshold);
  assert.equal(reasonOf(entry, 'wildcard_changes').value, entry.detail.changes);

  const spendable = squadState.picks.reduce((s, p) => s + p.sellingTenths, 0) + squadState.bankTenths;
  assert.equal(entry.detail.budgetTenths, spendable);
  assert.ok(entry.detail.costTenths <= spendable, 'a rebuild is priced at selling prices plus the bank');
});

test('a wildcard is played when the rebuild beats the current trajectory by more than the threshold', () => {
  // The squad is broken and the market is not: every held player is worth
  // almost nothing and every replacement is worth six a week.
  const held = new Set(SQUAD);
  const { evaluation } = scenario({ gw: 10, xp: id => (held.has(id) ? 0.4 : 6) });
  const entry = evaluation.perChip.wildcard;

  assert.ok(entry.valueNow >= CHIP_PARAMS.wildcardHorizonThreshold, `gain ${entry.valueNow}`);
  assert.equal(entry.recommended, true);
  assert.ok(entry.detail.changes >= 11, `a real rebuild, ${entry.detail.changes} changes`);
  assert.equal(evaluation.recommendation.decision, 'play');
});

test('the wildcard reports the gameweek the current squad breaks hardest', () => {
  const GW = 10;
  const { evaluation } = scenario({ gw: GW, xp: flat, blanks: { [GW + 4]: SQUAD_CLUBS.slice(0, 5) } });
  const entry = evaluation.perChip.wildcard;
  const structure = reasonOf(entry, 'wildcard_future_structure');
  assert.ok(structure, 'the scan reports a week');
  assert.ok(structure.text.includes(`Gameweek ${GW + 4}`));
  assert.ok(structure.value > 0);
  assert.equal(entry.bestGw, GW + 4);
});

// ---------------------------------------------------------------------------
// Picking between chips
// ---------------------------------------------------------------------------

test('only one chip is recommended, and it is the one furthest past its own bar', () => {
  const GW = 10;
  const star = SQUAD[7];
  const starClub = ROSTER.find(p => p.id === star).teamId;
  const { evaluation } = scenario({
    gw: GW,
    xp: id => (id === star ? 9 : 5),
    doubles: { [GW]: [...new Set([starClub, ...SQUAD_CLUBS])] },
  });

  const recommendedChips = Object.values(evaluation.perChip).filter(c => c.recommended);
  assert.ok(recommendedChips.length >= 2, 'the scenario is only interesting if two chips clear their bars');
  assert.equal(evaluation.recommendation.decision, 'play');

  const margins = recommendedChips.map(c => ({ chip: c.chip, margin: c.valueNow - (c.threshold || 0) }));
  margins.sort((a, b) => b.margin - a.margin);
  assert.equal(evaluation.recommendation.chip, margins[0].chip);
});

// ---------------------------------------------------------------------------
// Shared machinery the planner and the explanation layer both read
// ---------------------------------------------------------------------------

test('the discount weights are the same curve the planner reports', () => {
  assert.deepEqual(discountWeights(3, 1), [1, 1, 1]);
  const w = discountWeights(4, 0.85);
  assert.equal(w.length, 4);
  assert.equal(w[0], 1);
  for (let i = 1; i < w.length; i++) {
    assert.ok(Math.abs(w[i] - Math.pow(0.85, i)) < 1e-12);
    assert.ok(w[i] < w[i - 1]);
  }
});

test('a squad trajectory weighs each gameweek by its discount and counts the armband once', () => {
  const GW = 10;
  const fixtures = makeFixtures({ gwTo: RULES.totalEvents });
  const gameState = makeGameState(fixtures, GW);
  const projections = makeProjections(gameState, GW, GW + 4, flat);
  const t = squadTrajectory({
    squadIds: SQUAD, projections, gameState, rules: RULES, gwFrom: GW, horizon: 3, discount: 0.5,
  });

  assert.equal(t.gws.length, 3);
  assert.deepEqual(t.gws.map(g => g.gw), [GW, GW + 1, GW + 2]);
  assert.deepEqual(t.gws.map(g => g.weight), [1, 0.5, 0.25]);
  assert.ok(Math.abs(t.total - t.gws.reduce((s, g) => s + g.weight * g.xPoints, 0)) < 1e-9);
  for (const g of t.gws) {
    assert.equal(g.xPoints, g.xPointsXi + g.captainExtra);
    assert.equal(g.captainExtra, xpOf(projections, g.captain, g.gw));
    assert.equal(g.startingXI.length, RULES.starters);
    assert.equal(g.bench.order.length, 3);
  }
});

test('every reason is a formatted view of its own value', () => {
  assert.equal(makeReason('x', 'worth {v} points', 8.44).text, 'worth 8.4 points');
  assert.equal(makeReason('x', '{v}', 155, 'tenths').text, '£15.5m');
  assert.equal(makeReason('x', '{v}', 0.826, 'percent').text, '83%');
  assert.equal(makeReason('x', '{v}', 3.4, 'count').text, '3');
  assert.equal(makeReason('x', '{v}', 17, 'gw').text, '17');
  assert.equal(fmtValue(null, 'points'), '');
  assert.deepEqual(
    ['wildcard', 'freehit', 'bboost', '3xc', null].map(chipLabel),
    ['Wildcard', 'Free Hit', 'Bench Boost', 'Triple Captain', 'No chip'],
  );
});

// ---------------------------------------------------------------------------
// The planner's side of the contract
// ---------------------------------------------------------------------------

test('a chip that clears its bar becomes the plan, and the plan is legal', async () => {
  const GW = 10;
  const fixtures = makeFixtures({ gwTo: RULES.totalEvents, doubles: { [GW]: SQUAD_CLUBS } });
  const gameState = makeGameState(fixtures, GW);
  const projections = makeProjections(gameState, GW, GW + 8, flat);
  const squadState = makeSquadState({ gw: GW });

  const bundle = await buildPlan({
    gameState, squadState, options: { horizon: 5, seed: 3, projections, strength: {} },
  });

  assert.equal(bundle.chipEvaluation.recommendation.chip, 'bboost');
  assert.equal(bundle.current.chip, 'bboost');
  assert.equal(bundle.current.transferCount, 0, 'a bench boost is not a transfer');
  assert.equal(bundle.current.hits, 0);
  assert.deepEqual(bundle.validation, { ok: true, violations: [] });
  assert.deepEqual(validatePlan(bundle.current, bundle.squadState, gameState, RULES).violations, []);
  assert.equal(bundle.current.explanation.headline, 'Play your Bench Boost');
});

test('the planner never plays a chip outside its window', async () => {
  const GW = 1;
  // A gameweek 1 squad that would love a wildcard: everything owned is useless.
  const held = new Set(SQUAD);
  const fixtures = makeFixtures({ gwTo: RULES.totalEvents });
  const gameState = makeGameState(fixtures, GW);
  const projections = makeProjections(gameState, GW, GW + 8, id => (held.has(id) ? 0.4 : 6));
  const squadState = makeSquadState({ gw: GW });

  const bundle = await buildPlan({
    gameState, squadState, options: { horizon: 5, seed: 3, projections, strength: {} },
  });

  assert.notEqual(bundle.current.chip, 'wildcard');
  assert.notEqual(bundle.current.chip, 'freehit');
  if (bundle.current.chip) {
    assert.equal(chipAvailableAt(RULES, bundle.current.chip, GW, []), true);
  }
  assert.deepEqual(bundle.validation, { ok: true, violations: [] });
});

test('a chip already played is never planned again', async () => {
  const GW = 10;
  const fixtures = makeFixtures({ gwTo: RULES.totalEvents, doubles: { [GW]: SQUAD_CLUBS } });
  const gameState = makeGameState(fixtures, GW);
  const projections = makeProjections(gameState, GW, GW + 8, flat);
  const squadState = makeSquadState({ gw: GW, chipsUsed: [{ name: 'bboost', event: 4 }] });

  const bundle = await buildPlan({
    gameState, squadState, options: { horizon: 5, seed: 3, projections, strength: {} },
  });
  assert.notEqual(bundle.current.chip, 'bboost');
  assert.deepEqual(bundle.validation, { ok: true, violations: [] });
});
