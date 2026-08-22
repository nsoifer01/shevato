import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { pitchViewModel } from '../js/ui/pitch.js';
import { squadLegality, blockedReason, searchPlayers, manualSquadState, MANUAL_TRANSFER_STATE } from '../js/ui/preseason.js';
import { freeTransfersFor, isUnlimited } from '../js/engine/transfer-state.js';
import { deletionOutcomeText } from '../js/ui/settings.js';
import { recommendationLine, reasonLabel } from '../js/ui/history.js';
import { validatePlan } from '../js/engine/validate.js';

// The view modules build DOM, but the decisions inside them are pure and are
// tested here: which squad the pitch shows, whether a manual squad is legal,
// and exactly what a deletion tells the user it removed.

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const gameState = buildGameState(
  { ...read('fixtures', 'bootstrap.json'), events: read('fixtures', 'events-in-season.json') },
  read('fixtures', 'fixtures.json'),
  { fetchedAt: '2026-09-24T10:00:00Z' },
);
const rules = gameState.rules;
const squadState = buildSquadState({
  entry: read('fixtures', 'entry.json'),
  history: read('fixtures', 'entry-history.json'),
  transfers: read('fixtures', 'entry-transfers.json'),
  picks: read('fixtures', 'entry-picks.json'),
  gameState,
  gw: 6,
});

/* ------------------------------------------------------------------ pitch */

// FPL numbers a squad 1-11 for the eleven that starts (exactly one keeper),
// 12 for the reserve keeper and 13-15 for the ordered outfield bench. The
// committed fixture stores its picks grouped by position instead, so the
// current-team view is tested against a squad laid out the way the API does it.
function inRealSlotOrder(state) {
  const positionOf = id => gameState.players.get(id).position;
  const ids = state.picks.map(p => p.playerId);
  const gks = ids.filter(id => positionOf(id) === 1);
  const defs = ids.filter(id => positionOf(id) === 2);
  const mids = ids.filter(id => positionOf(id) === 3);
  const fwds = ids.filter(id => positionOf(id) === 4);
  const ordered = [
    gks[0],
    ...defs.slice(0, 4),
    ...mids.slice(0, 4),
    ...fwds.slice(0, 2),
    gks[1],
    defs[4], mids[4], fwds[2],
  ];
  const byId = new Map(state.picks.map(p => [p.playerId, p]));
  return { ...state, picks: ordered.map((id, i) => ({ ...byId.get(id), slot: i + 1 })) };
}

const held = squadState.picks.map(p => p.playerId);
const plan = {
  gw: 6,
  transfersOut: [held[0]],
  transfersIn: [9999],
  squad: held.slice(1).concat(9999),
  startingXI: held.slice(0, 11),
  formation: '3-4-3',
  bench: { gk: held[11], order: [held[12], held[13], held[14]] },
  captain: held[5],
  viceCaptain: held[6],
};

test('the recommended view shows the plan and marks what it buys', () => {
  const vm = pitchViewModel({ mode: 'recommended', plan, squadState, gameState });
  assert.deepEqual(vm.startingXI, plan.startingXI);
  assert.equal(vm.formation, '3-4-3');
  assert.equal(vm.captain, plan.captain);
  assert.deepEqual([...vm.movesIn], [9999]);
  assert.equal(vm.movesOut.size, 0, 'a sold player is not on the recommended pitch');
});

test('the current view is built from the real picks, with its own formation', () => {
  const realistic = inRealSlotOrder(squadState);
  const outgoing = realistic.picks[2].playerId;
  const vm = pitchViewModel({ mode: 'current', plan: { ...plan, transfersOut: [outgoing] }, squadState: realistic, gameState });
  assert.equal(vm.startingXI.length, 11);
  assert.equal(vm.formation, '4-4-2');
  const counts = vm.formation.split('-').map(Number);
  assert.equal(counts.reduce((a, b) => a + b, 0), 10, 'ten outfielders plus the keeper');
  assert.equal(vm.bench.order.length, 3);
  assert.equal(gameState.players.get(vm.bench.gk).position, 1, 'the reserve keeper is the bench GK');
  assert.deepEqual([...vm.movesOut], [outgoing], 'the current squad is where an outgoing player still is');
  assert.equal(vm.movesIn.size, 0);
});

test('the current view reads the armbands from the picks, not from the plan', () => {
  const realistic = inRealSlotOrder(squadState);
  const withCaptain = {
    ...realistic,
    picks: realistic.picks.map((p, i) => ({ ...p, isCaptain: i === 3, isViceCaptain: i === 4 })),
  };
  const vm = pitchViewModel({ mode: 'current', plan, squadState: withCaptain, gameState });
  assert.equal(vm.captain, withCaptain.picks[3].playerId);
  assert.equal(vm.viceCaptain, withCaptain.picks[4].playerId);
  assert.notEqual(vm.captain, plan.captain);
});

/* ------------------------------------------------------- manual squad entry */

const byPosition = (pos) => [...gameState.players.values()].filter(p => p.position === pos);

// The cheapest legal fifteen available in the fixture, which is what a manual
// entry screen has to be able to accept.
function cheapestSquad() {
  const ids = [];
  for (const pos of Object.values(rules.positions)) {
    const list = byPosition(pos.id).slice().sort((a, b) => a.nowCost - b.nowCost);
    const clubs = new Map();
    for (const player of list) {
      if (ids.filter(id => gameState.players.get(id).teamId === player.teamId).length >= rules.clubLimit) continue;
      ids.push(player.id);
      clubs.set(player.teamId, true);
      if (byPosition(pos.id).filter(p => ids.includes(p.id)).length === pos.squadSelect) break;
    }
  }
  return ids;
}

test('an empty squad is legal but not complete', () => {
  const state = squadLegality([], gameState);
  assert.equal(state.ok, false);
  assert.equal(state.complete, false);
  assert.deepEqual(state.issues, []);
  assert.equal(state.remaining, rules.budgetTenths);
});

test('counters, spend and remaining budget track the picks', () => {
  const ids = byPosition(1).slice(0, 2).map(p => p.id);
  const state = squadLegality(ids, gameState);
  assert.equal(state.counts[1], 2);
  assert.equal(state.spend, ids.reduce((s, id) => s + gameState.players.get(id).nowCost, 0));
  assert.equal(state.remaining, rules.budgetTenths - state.spend);
});

test('too many in a position is reported in words', () => {
  const ids = byPosition(1).slice(0, 3).map(p => p.id);
  const issues = squadLegality(ids, gameState).issues;
  assert.equal(issues.length, 1);
  assert.match(issues[0], /3 GKP selected, the maximum is 2/);
});

test('a fourth player from one club is reported by club name', () => {
  const teamId = [...gameState.teams.keys()][0];
  const ids = [...gameState.players.values()].filter(p => p.teamId === teamId).slice(0, 4).map(p => p.id);
  const issues = squadLegality(ids, gameState).issues;
  assert.ok(issues.some(i => /4 players from .*the limit is 3/.test(i)), issues.join(' | '));
});

test('going over budget is reported to the tenth', () => {
  const dear = [...gameState.players.values()].slice().sort((a, b) => b.nowCost - a.nowCost);
  const ids = [];
  let spend = 0;
  for (const player of dear) {
    ids.push(player.id);
    spend += player.nowCost;
    if (spend > rules.budgetTenths) break;
  }
  const state = squadLegality(ids, gameState);
  assert.ok(state.issues.some(i => /Over budget by £/.test(i)), state.issues.join(' | '));
  assert.ok(state.remaining < 0);
});

test('a complete legal fifteen passes', () => {
  const ids = cheapestSquad();
  const state = squadLegality(ids, gameState);
  assert.equal(ids.length, rules.squadSize);
  assert.deepEqual(state.issues, []);
  assert.equal(state.complete, true);
  assert.equal(state.ok, true);
});

test('a player is blocked with the reason that blocks him', () => {
  const gkIds = byPosition(1).slice(0, 2).map(p => p.id);
  const thirdGk = byPosition(1)[2];
  assert.match(blockedReason(thirdGk.id, gkIds, gameState), /already have 2 GKP/);
  assert.match(blockedReason(gkIds[0], gkIds, gameState), /Already selected/);

  const teamId = [...gameState.teams.keys()][0];
  const clubIds = [...gameState.players.values()].filter(p => p.teamId === teamId).slice(0, 3).map(p => p.id);
  const fourth = [...gameState.players.values()].find(p => p.teamId === teamId && !clubIds.includes(p.id));
  assert.match(blockedReason(fourth.id, clubIds, gameState), /Already 3 from that club/);

  const dearest = [...gameState.players.values()].sort((a, b) => b.nowCost - a.nowCost)[0];
  assert.match(blockedReason(dearest.id, [], gameState, { budgetTenths: 10 }), /Costs £/);
  assert.equal(blockedReason(dearest.id, [], gameState), null);
});

test('search filters by name and position and is ordered by price', () => {
  const all = searchPlayers(gameState, { limit: 5 });
  assert.equal(all.length, 5);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].nowCost >= all[i].nowCost);

  const keepers = searchPlayers(gameState, { position: 1, limit: 50 });
  assert.ok(keepers.length > 0);
  assert.ok(keepers.every(p => p.position === 1));

  const target = all[0];
  const byName = searchPlayers(gameState, { query: target.webName.slice(0, 4).toLowerCase(), limit: 50 });
  assert.ok(byName.some(p => p.id === target.id));
  assert.equal(searchPlayers(gameState, { query: 'zzzzzz-no-such-player' }).length, 0);
});

test('a typed squad becomes a SquadState the planner can validate against', () => {
  const ids = cheapestSquad();
  const state = manualSquadState({ ids, gameState, gw: 6, entry: read('fixtures', 'entry.json') });
  assert.equal(state.source, 'manual');
  assert.equal(state.picks.length, rules.squadSize);
  // A typed pre-season squad is still PRE-SEASON, so its allowance is unlimited
  // rather than a number. This asserted a hardcoded 2, which encoded a limit of
  // the transfer search as if it were a rule of the game.
  assert.equal(state.freeTransfers, freeTransfersFor(MANUAL_TRANSFER_STATE));
  assert.equal(isUnlimited(state.transferState), true, 'pre-season is unlimited, not a count');
  // And chips are whatever the rules allow now, not an empty list: bench boost
  // and triple captain are both playable from GW1.
  assert.ok(state.chipsAvailable.length > 0, 'a fresh squad owns its chips');
  const spend = ids.reduce((s, id) => s + gameState.players.get(id).nowCost, 0);
  assert.equal(state.bankTenths, rules.budgetTenths - spend);
  assert.equal(state.picks.every(p => p.sellingTenths === p.purchaseTenths), true);
  assert.deepEqual(state.picks.map(p => p.slot), ids.map((_, i) => i + 1));

  // A no-transfer plan over that squad has to be legal, which is what the
  // planner will produce from it.
  const xi = ids.slice(0, 11);
  const noop = {
    gw: 6, chip: null, transfersOut: [], transfersIn: [], transferCount: 0,
    freeTransfersUsed: 0, freeTransfersAfter: freeTransfersFor(MANUAL_TRANSFER_STATE), hits: 0, hitCostPoints: 0,
    bankBeforeTenths: state.bankTenths, moneyInTenths: 0, moneyOutTenths: 0,
    bankAfterTenths: state.bankTenths,
    squad: ids.slice(),
    startingXI: xi,
    formation: '3-4-3',
    bench: { gk: ids[1], order: [ids[12], ids[13], ids[14]] },
    captain: xi[5], viceCaptain: xi[6],
  };
  const check = validatePlan(noop, state, gameState, rules);
  assert.equal(check.violations.some(v => v.code === 'budget'), false, JSON.stringify(check.violations));
  assert.equal(check.violations.some(v => v.code === 'club_limit'), false);
  assert.equal(check.violations.some(v => v.code === 'squad_size'), false);
});

/* --------------------------------------------------------------- deletion */

test('a deletion says which copy it actually removed', () => {
  const signedOut = deletionOutcomeText({ scope: 'all', signedIn: false, cloudOk: false });
  assert.match(signedOut, /removed from this device/);
  assert.match(signedOut, /not signed in/);
  assert.doesNotMatch(signedOut, /and from your Shevato account/);

  const signedIn = deletionOutcomeText({ scope: 'all', signedIn: true, cloudOk: true });
  assert.match(signedIn, /this device and from your Shevato account/);
  assert.match(signedIn, /Other devices drop it on their next sync/);

  const failed = deletionOutcomeText({ scope: 'all', signedIn: true, cloudOk: false, cloudError: 'offline' });
  assert.match(failed, /could not be deleted \(offline\)/);
  assert.doesNotMatch(failed, /^All FPL Planner data was removed from this device and from/);
});

test('disconnecting and deleting describe different things', () => {
  const team = deletionOutcomeText({ scope: 'team', signedIn: true, cloudOk: true });
  const all = deletionOutcomeText({ scope: 'all', signedIn: true, cloudOk: true });
  assert.match(team, /^Your FPL team link/);
  assert.match(all, /^All FPL Planner data/);
});

/* ---------------------------------------------------------------- history */

test('a stored plan is restated as an action, never as a rationale', () => {
  const entry = {
    plan: {
      headline: 'Make 1 transfer',
      transferCount: 1,
      transfersOut: [held[0]],
      transfersIn: [held[1]],
    },
  };
  const line = recommendationLine(entry, gameState);
  assert.match(line, /^Make 1 transfer: /);
  assert.match(line, new RegExp(`${gameState.players.get(held[0]).webName} out`));
  assert.equal(recommendationLine({ plan: { headline: 'Roll your transfer', transferCount: 0, transfersOut: [], transfersIn: [] } }, gameState), 'Roll your transfer');
  assert.equal(recommendationLine(null, gameState), null);
});

test('recalculation reasons render as sentences, unknown codes pass through', () => {
  assert.equal(reasonLabel('squad-changed'), 'Your squad changed');
  assert.equal(reasonLabel('first-calculation'), 'First plan for this gameweek');
  assert.equal(reasonLabel('something-new'), 'something-new');
  assert.equal(reasonLabel(undefined), 'Recalculated');
});

/* ------------------------------- what "no squad to import" actually means */

// Absence of picks is not the same fact as the season not having started, and
// the £100.0m budget the builder then offers is a third claim again. Before
// this, a mid-season manager whose picks were briefly unavailable was told the
// season had not started and handed a full budget.
test('the four reasons a squad cannot be imported are told apart', async () => {
  const { noSquadReason } = await import('../js/ui/preseason.js');
  const preSeason = { seasonStarted: false, currentEvent: null, events: [] };
  const inSeason = { seasonStarted: true, currentEvent: 5, events: [] };

  assert.equal(noSquadReason({ gameState: preSeason, entry: null }), 'preseason');
  assert.equal(noSquadReason({ gameState: preSeason, entry: { started_event: 1 } }), 'preseason');

  // A manager who enters later this season has genuinely played nothing.
  assert.equal(noSquadReason({ gameState: inSeason, entry: { started_event: 7 } }), 'new-entry');

  // A manager who started at GW1 and is missing picks in GW5 owns a squad the
  // API did not hand over. Calling that "the season has not started" is false,
  // and offering him a full budget is worse.
  assert.equal(noSquadReason({ gameState: inSeason, entry: { started_event: 1 } }), 'picks-unavailable');
  assert.equal(noSquadReason({ gameState: inSeason, entry: null }), 'picks-unavailable');
});

/* --------------------------------------- a gameweek in play is not finished */

test('a gameweek still being played is kept out of the finalised season summary', async () => {
  const { isFinalisedEvent } = await import('../js/ui/history.js');
  const gs = {
    events: [
      { id: 1, finished: true, dataChecked: true },
      { id: 2, finished: true, dataChecked: false },   // played, bonus not applied
      { id: 3, finished: false, dataChecked: false },  // in play
    ],
  };
  assert.equal(isFinalisedEvent(1, gs), true);
  assert.equal(isFinalisedEvent(2, gs), false, 'finished is not final until the data is checked');
  assert.equal(isFinalisedEvent(3, gs), false);
  // A gameweek the calendar does not know about is taken as given rather than
  // being hidden from a manager's own history.
  assert.equal(isFinalisedEvent(9, gs), true);
});

/* ------------------------- the glance tiles while a gameweek is in play */

// GW1 of 2026/27 in play: the history row carries 14 points and a published
// overall rank, nothing is finalised. The rank the table prints must not read
// "-" in the tile above it, and the total must be labelled provisional.
test('the glance tiles show the live rank and label live points provisional', async () => {
  const { seasonSummary, glanceFacts } = await import('../js/ui/history.js');
  const gs = { events: [{ id: 1, finished: false, dataChecked: false }, { id: 2, finished: false, dataChecked: false }] };
  const liveRow = { event: 1, points: 14, total_points: 14, rank: 3847334, overall_rank: 3847330, event_transfers: 0, event_transfers_cost: 0, points_on_bench: 0 };

  const s = seasonSummary([liveRow], gs);
  assert.equal(s.latest, null, 'nothing is finalised');
  assert.equal(s.live.event, 1);
  assert.equal(s.meanPoints, null, 'a live gameweek is not averaged');

  const facts = glanceFacts(s);
  assert.equal(facts.overallRank.value, '3,847,330', 'the rank the row prints is the rank the tile prints');
  assert.equal(facts.overallRank.note, 'Gameweek 1 so far, provisional');
  assert.equal(facts.totalPoints.value, '14');
  assert.equal(facts.totalPoints.note, 'Gameweek 1 so far, provisional');

  // FPL has not published a rank yet (usual while the games are on): no
  // number is invented.
  const unranked = glanceFacts(seasonSummary([{ ...liveRow, overall_rank: null }], gs));
  assert.equal(unranked.overallRank.value, '-');
  assert.equal(unranked.overallRank.note, 'after the first finalised gameweek');
  assert.equal(unranked.totalPoints.note, 'Gameweek 1 so far, provisional');
});

test('once a gameweek is finalised the glance tiles describe it and exclude the live one', async () => {
  const { seasonSummary, glanceFacts } = await import('../js/ui/history.js');
  const gs = { events: [{ id: 1, finished: true, dataChecked: true }, { id: 2, finished: false, dataChecked: false }] };
  const gw1 = { event: 1, points: 62, total_points: 62, rank: 1500000, overall_rank: 1500000, event_transfers: 0, event_transfers_cost: 0, points_on_bench: 4 };
  const gw2 = { event: 2, points: 9, total_points: 71, rank: 900000, overall_rank: 1200000, event_transfers: 1, event_transfers_cost: 0, points_on_bench: 0 };

  const s = seasonSummary([gw1, gw2], gs);
  assert.equal(s.latest.event, 1);
  assert.equal(s.live.event, 2);
  assert.equal(s.meanPoints, 62, 'the live 9 points stay out of the season average');

  const facts = glanceFacts(s);
  assert.equal(facts.totalPoints.value, '62', 'the live running total is not the season total');
  assert.equal(facts.totalPoints.note, 'after Gameweek 1');
  assert.equal(facts.overallRank.value, '1,500,000', 'the finalised rank, not the moving live one');
  assert.equal(facts.overallRank.note, 'after Gameweek 1');
});
