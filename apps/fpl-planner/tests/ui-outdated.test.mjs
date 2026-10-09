// "Plan outdated", driven from the data rather than from hand-written
// fingerprint strings.
//
// The banner in app.js is shown exactly when `outdatedReason(storedFingerprint,
// freshFingerprint)` returns something, and that pair of fingerprints is built
// from raw FPL payloads. So this file computes a real plan, stores it the way
// the app stores it, then re-runs the refresh path against payloads mutated the
// way an upstream refresh would move them (a price change, an injury flag, a
// fixture move, an upstream transfer, a free transfer spent, a new gameweek)
// and asserts which banner state each one produces.
//
// This is what used to need "a real team's data changing between two visits".
//
// The fingerprints are taken exactly the way js/app.js takes them: WITH the
// plan when it is computed (so its scope, the players it moves and the
// fixtures it was judged on, is recorded), and with that stored scope on every
// later check (fingerprintScope). The fixture plan moves players (a Free Hit
// at the time of writing), which is what lets the cases below tell "a player
// the plan names" from "a player it does not" (2026-10-09 audit B11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { buildPlan } from '../js/engine/planner.js';
import { inputFingerprint, fingerprintScope, outdatedReason, getProjection } from '../js/ui/plan-model.js';
import { recordPlanVersion, latestVersion } from '../js/ui/store.js';
import { planInputs } from '../js/ui/plan-diff.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

const FETCHED_AT = '2026-09-24T10:00:00Z';
const PLAN_GW = 6;
const HAALAND = 411;   // FWD, club 15
const GABRIEL = 4;     // DEF, club 1
const THIAGO = 106;    // FWD, club 4, not in the squad

// One fetch of every endpoint the planner reads, mutated before it is
// normalized. `mutate` receives the raw payloads, exactly as the proxy would
// hand them over on a later visit.
function fetchWorld(mutate = () => {}) {
  const payload = {
    bootstrap: read('bootstrap.json'),
    events: read('events-in-season.json'),
    fixtures: read('fixtures.json'),
    entry: read('entry.json'),
    history: read('entry-history.json'),
    transfers: read('entry-transfers.json'),
    picks: read('entry-picks.json'),
    gw: PLAN_GW,
  };
  mutate(payload);
  return worldFrom(payload);
}

function worldFrom(payload) {
  const gameState = buildGameState(
    { ...payload.bootstrap, events: payload.events },
    payload.fixtures,
    { fetchedAt: FETCHED_AT },
  );
  const squadState = buildSquadState({
    entry: payload.entry,
    history: payload.history,
    transfers: payload.transfers,
    picks: payload.picks,
    gameState,
    gw: payload.gw,
  });
  return { gameState, squadState };
}

const first = fetchWorld();

// The stored plan, recorded the way js/app.js records it (computePlan): one
// history entry carrying the fingerprint of the inputs the plan was built
// from, taken WITH the plan.
const planBundle = await buildPlan({
  gameState: first.gameState,
  squadState: first.squadState,
  options: { horizon: 3 },
});
const storedFingerprint = inputFingerprint(first.squadState, first.gameState, planBundle.current);
const history = recordPlanVersion({}, PLAN_GW, {
  plan: planBundle.current,
  reason: 'first-calculation',
  computedAt: '2026-09-24T10:00:05Z',
  fingerprint: storedFingerprint,
});

const plan = planBundle.current;
const named = new Set([...plan.transfersIn, ...plan.transfersOut]);
const held = new Set(first.squadState.picks.map(p => p.playerId));
const planClubs = new Set([...held, ...named].map(id => first.gameState.players.get(id).teamId));
// A player the manager neither holds nor is told to buy or sell.
const UNRELATED = [...first.gameState.players.values()]
  .find(p => !held.has(p.id) && !named.has(p.id) && p.status === 'a').id;
const BUY = plan.transfersIn.find(id => !held.has(id));

// What the app does on "Check for changes": re-read, re-fingerprint over the
// stored fingerprint's scope, compare. Non-null is the banner.
function refresh(mutate) {
  const next = fetchWorld(mutate);
  const stored = latestVersion(history, PLAN_GW);
  const fingerprint = inputFingerprint(next.squadState, next.gameState, null, fingerprintScope(stored.fingerprint));
  return { reason: outdatedReason(stored.fingerprint, fingerprint), next: { ...next, fingerprint } };
}

test('the fixture plan names players beyond the squad, which the cases below depend on', () => {
  assert.ok(BUY !== undefined, 'the fixture plan recommends buying someone not held; if the engine stops doing that, give these cases a plan that does');
  assert.ok(UNRELATED !== undefined);
  assert.ok(!named.has(UNRELATED) && !held.has(UNRELATED));
});

test('the stored plan carries the fingerprint of the inputs it was built from', () => {
  const stored = latestVersion(history, PLAN_GW);
  assert.equal(stored.version, 1);
  assert.equal(stored.reason, 'first-calculation');
  assert.equal(stored.fingerprint, storedFingerprint);
  assert.equal(stored.plan.gw, PLAN_GW);
  assert.ok(stored.fingerprint.startsWith(`gw:${PLAN_GW}|`), stored.fingerprint.slice(0, 40));
});

test('re-reading unchanged data leaves the plan current, with no banner', () => {
  const { reason } = refresh(() => {});
  assert.equal(reason, null);
});

test('a price rise on a held player marks the plan outdated', () => {
  const { reason, next } = refresh((p) => {
    const player = p.bootstrap.elements.find(e => e.id === HAALAND);
    player.now_cost += 1;
  });
  assert.ok(reason, 'a price change is exactly what the fingerprint exists to catch');
  assert.equal(reason.code, 'players-changed');
  assert.equal(reason.text, 'Prices or player availability changed since this plan was calculated.');
  assert.notEqual(next.fingerprint, first.fingerprint);
});

test('an injury flag on a held player marks the plan outdated', () => {
  const { reason } = refresh((p) => {
    const player = p.bootstrap.elements.find(e => e.id === GABRIEL);
    player.status = 'i';
    player.news = 'Knee injury - expected back 15 Oct';
    player.chance_of_playing_next_round = 0;
  });
  assert.equal(reason.code, 'players-changed');
});

test('a price change on a player the manager does not own is not the manager\'s problem', () => {
  // Pinned since the fingerprint existed, and still true for a player the plan
  // does not name: the whole player pool moving is not a reason to redo it.
  const { reason } = refresh((p) => {
    const player = p.bootstrap.elements.find(e => e.id === UNRELATED);
    player.now_cost += 3;
    player.status = 'i';
    player.news = 'Hamstring injury';
    player.chance_of_playing_next_round = 0;
  });
  assert.equal(reason, null, 'the fingerprint covers the held squad and the plan\'s moves, not the whole player pool');
});

// B11. The player the plan tells you to buy is the one whose news matters most.
test('B11: the recommended buy being flagged marks the plan outdated', () => {
  const { reason } = refresh((p) => {
    const player = p.bootstrap.elements.find(e => e.id === BUY);
    player.status = 'd';
    player.news = 'Knock - 75% chance of playing';
    player.chance_of_playing_next_round = 75;
  });
  assert.ok(reason, 'a doubt on the player being bought is exactly what a re-check must report');
  assert.equal(reason.code, 'players-changed');
  assert.equal(reason.text, 'Prices or player availability changed since this plan was calculated.');
});

test('B11: each field of a recommended buy is watched on its own', () => {
  const field = (mutate) => refresh((p) => mutate(p.bootstrap.elements.find(e => e.id === BUY))).reason;
  assert.equal(field(e => { e.now_cost += 1; }).code, 'players-changed', 'price');
  assert.equal(field(e => { e.status = 'i'; }).code, 'players-changed', 'status');
  assert.equal(field(e => { e.chance_of_playing_next_round = 50; }).code, 'players-changed', 'chance of playing');
  assert.equal(field(e => { e.news = 'Illness'; }).code, 'players-changed', 'news, even before the status moves');
});

test('B11: the fingerprint watches every per-player field plan-diff stores for a plan, except the projection', () => {
  // planInputs is what the "what changed" notice cites. If it grows a field,
  // the fingerprint has to grow it too, or a re-check stays silent about a move
  // the notice would explain. `x` (the projection) needs a recompute, which is
  // the one thing a re-check does not do.
  const inputs = planInputs({ plan, projections: planBundle.projections, squadState: first.squadState, gameState: first.gameState });
  assert.deepEqual(Object.keys(inputs.players[BUY]).sort(), ['c', 'p', 's', 'x'],
    'planInputs changed shape: cover the new field in inputFingerprint (js/ui/plan-model.js) and here');
  for (const id of named) assert.ok(id in inputs.players, `planInputs covers moved player ${id}`);
});

test('B11: a recommended sale being flagged marks the plan outdated', () => {
  const sell = plan.transfersOut[0];
  const { reason } = refresh((p) => {
    const player = p.bootstrap.elements.find(e => e.id === sell);
    player.news = 'Suspended for one match';
    player.chance_of_playing_next_round = 0;
  });
  assert.equal(reason.code, 'players-changed');
});

test('B11: a fingerprint stored before plan scopes existed is still compared on the squad alone', () => {
  // Synced history written by the previous release carries no scope; it must
  // not read as "changed" on the first check after this one ships.
  const legacy = inputFingerprint(first.squadState, first.gameState);
  assert.equal(fingerprintScope(legacy), null);
  const next = fetchWorld((p) => { p.bootstrap.elements.find(e => e.id === BUY).status = 'i'; });
  assert.equal(outdatedReason(legacy, inputFingerprint(next.squadState, next.gameState, null, fingerprintScope(legacy))), null);
});

test('a transfer made elsewhere marks the plan outdated as a squad change', () => {
  const { reason } = refresh((p) => {
    p.picks.picks[14].element = THIAGO;
  });
  assert.equal(reason.code, 'squad-changed');
  assert.equal(reason.text, 'Team updated. We\'ve rebuilt your plan based on your current squad.');
});

test('spending a free transfer marks the plan outdated as a budget change', () => {
  const { reason } = refresh((p) => {
    const rows = p.history.current;
    rows[rows.length - 1].event_transfers += 1;
  });
  assert.equal(reason.code, 'budget-changed');
  assert.equal(reason.text, 'Your bank or free transfers changed since this plan was calculated.');
});

test('money moving in the bank marks the plan outdated as a budget change', () => {
  const { reason } = refresh((p) => {
    p.picks.entry_history.bank += 5;
  });
  assert.equal(reason.code, 'budget-changed');
});

test('a new gameweek outranks everything else that moved with it', () => {
  const { reason } = refresh((p) => {
    p.gw = PLAN_GW + 1;
    p.picks.picks[14].element = THIAGO;
    p.picks.entry_history.bank += 5;
    p.bootstrap.elements.find(e => e.id === HAALAND).now_cost += 1;
  });
  assert.equal(reason.code, 'new-gameweek', 'the oldest fact about a stale plan is the one worth saying');
  assert.equal(reason.text, 'A new gameweek has started, so this plan was built for the previous deadline.');
});

// The fingerprint grew a fixture component for the clubs the plan touches
// (audit B11), so the scope limit this used to pin now applies only to clubs
// the plan does not involve: their calendar moving changes projections the
// plan never used.
test('a fixture moving gameweeks between clubs the plan does not involve does NOT mark the plan outdated', () => {
  // A club with exactly one gameweek 6 fixture, so moving it leaves a blank
  // rather than turning a double into a single (the fixture set deliberately
  // contains both shapes), and neither side of it held or named by the plan.
  const gw6 = read('fixtures.json').filter(f => f.event === PLAN_GW);
  const movedFixture = gw6.find(f => gw6.filter(o => o.team_h === f.team_h || o.team_a === f.team_h).length === 1
    && !planClubs.has(f.team_h) && !planClubs.has(f.team_a));
  assert.ok(movedFixture, 'the fixture set has a gameweek 6 match between two clubs outside the plan');
  const moveFixture = (p) => {
    const fixture = p.fixtures.find(f => f.id === movedFixture.id);
    fixture.event = PLAN_GW + 1;
    fixture.kickoff_time = '2026-10-05T14:00:00Z';
  };
  const { reason, next } = refresh(moveFixture);
  assert.equal(next.fingerprint, storedFingerprint, 'the fingerprint covers the plan\'s clubs, not the whole calendar');
  assert.equal(reason, null);

  // The input really did move: the home club loses its gameweek 6 game, so its
  // players' expected points for the planned gameweek change. The banner simply
  // does not watch this.
  const affectedClub = movedFixture.team_h;
  const affectedPlayer = read('bootstrap.json').elements.find(e => e.team === affectedClub);
  const xpFor = (world) => {
    const strength = buildStrength(world.gameState, { asOfGw: PLAN_GW - 1 });
    const projections = buildProjections({
      gameState: world.gameState, strength, gwFrom: PLAN_GW, gwTo: PLAN_GW,
    });
    return getProjection(projections, affectedPlayer.id, PLAN_GW);
  };
  const before = xpFor(first);
  const after = xpFor(fetchWorld(moveFixture));
  assert.equal(before.fixtures.length, 1);
  assert.equal(after.fixtures.length, 0, 'the club now has a blank in the planned gameweek');
  assert.ok(before.xPoints > 0);
  assert.equal(after.xPoints, 0);
});

test('B11: a fixture moving for a club the plan buys from marks the plan outdated, and says so', () => {
  const buyClub = first.gameState.players.get(BUY).teamId;
  const fixture = read('fixtures.json').find(f => f.event === PLAN_GW && (f.team_h === buyClub || f.team_a === buyClub));
  const { reason } = refresh((p) => {
    const f = p.fixtures.find(x => x.id === fixture.id);
    f.event = PLAN_GW + 1;
    f.kickoff_time = '2026-10-05T14:00:00Z';
  });
  assert.ok(reason, 'the buy now has a blank the plan never saw');
  assert.equal(reason.code, 'players-changed');
  assert.equal(reason.text, 'The fixtures for players in this plan changed since it was calculated.');
});

test('B11: a fixture moving outside the plan\'s gameweeks does not count, even for a club it buys from', () => {
  // The fixture set stops at gameweek 6, so the move is between two played
  // gameweeks before the horizon (6 to 8): history, not anything the plan used.
  const buyClub = first.gameState.players.get(BUY).teamId;
  const earlier = read('fixtures.json').find(f => f.event > 1 && f.event < PLAN_GW && (f.team_h === buyClub || f.team_a === buyClub));
  assert.ok(earlier);
  const { reason } = refresh((p) => { p.fixtures.find(x => x.id === earlier.id).event = earlier.event - 1; });
  assert.equal(reason, null);
});

test('every outdated reason gives the user a code to act on and a sentence that does not blame them', () => {
  const seen = new Set();
  for (const mutate of [
    (p) => { p.bootstrap.elements.find(e => e.id === HAALAND).now_cost += 1; },
    (p) => { p.picks.picks[14].element = THIAGO; },
    (p) => { p.picks.entry_history.bank += 5; },
    (p) => { p.gw = PLAN_GW + 1; },
  ]) {
    const { reason } = refresh(mutate);
    assert.ok(reason.code && reason.text, JSON.stringify(reason));
    assert.doesNotMatch(reason.text, /you (?:should|failed|ignored|did not)/i);
    seen.add(reason.code);
  }
  assert.deepEqual([...seen].sort(), ['budget-changed', 'new-gameweek', 'players-changed', 'squad-changed']);
});
