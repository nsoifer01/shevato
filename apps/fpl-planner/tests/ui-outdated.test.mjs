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
import { inputFingerprint, outdatedReason, getProjection } from '../js/ui/plan-model.js';
import { recordPlanVersion, latestVersion } from '../js/ui/store.js';

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
  return { gameState, squadState, fingerprint: inputFingerprint(squadState, gameState) };
}

const first = fetchWorld();

// The stored plan, recorded the way js/app.js records it: one history entry
// carrying the fingerprint of the inputs the plan was built from.
const planBundle = await buildPlan({
  gameState: first.gameState,
  squadState: first.squadState,
  options: { horizon: 3 },
});
const history = recordPlanVersion({}, PLAN_GW, {
  plan: planBundle.current,
  reason: 'first-calculation',
  computedAt: '2026-09-24T10:00:05Z',
  fingerprint: first.fingerprint,
});

// What the app does on "Check for changes": re-read, re-fingerprint, compare
// against the stored plan's fingerprint. Non-null is the banner.
function refresh(mutate) {
  const next = fetchWorld(mutate);
  const stored = latestVersion(history, PLAN_GW);
  return { reason: outdatedReason(stored.fingerprint, next.fingerprint), next };
}

test('the stored plan carries the fingerprint of the inputs it was built from', () => {
  const stored = latestVersion(history, PLAN_GW);
  assert.equal(stored.version, 1);
  assert.equal(stored.reason, 'first-calculation');
  assert.equal(stored.fingerprint, first.fingerprint);
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
  const { reason } = refresh((p) => {
    const player = p.bootstrap.elements.find(e => e.id === THIAGO);
    player.now_cost += 3;
    player.status = 'i';
  });
  assert.equal(reason, null, 'the fingerprint covers the held squad, not the whole player pool');
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

// A known scope limit, asserted so it stays visible rather than being
// rediscovered. If this test ever fails because the fingerprint grew a fixture
// component, that is the fix, not a regression: update the assertion.
test('a fixture moving gameweeks changes the projections but does NOT mark the plan outdated', () => {
  // A club with exactly one gameweek 6 fixture, so moving it leaves a blank
  // rather than turning a double into a single (the fixture set deliberately
  // contains both shapes).
  const gw6 = read('fixtures.json').filter(f => f.event === PLAN_GW);
  const movedFixture = gw6.find(f => gw6.filter(o => o.team_h === f.team_h || o.team_a === f.team_h).length === 1);
  const moveFixture = (p) => {
    const fixture = p.fixtures.find(f => f.id === movedFixture.id);
    fixture.event = PLAN_GW + 1;
    fixture.kickoff_time = '2026-10-05T14:00:00Z';
  };
  const { reason, next } = refresh(moveFixture);
  assert.equal(next.fingerprint, first.fingerprint, 'the fingerprint covers the squad, the money and each held player, not the calendar');
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
