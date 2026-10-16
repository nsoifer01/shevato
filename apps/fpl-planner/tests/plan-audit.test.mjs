// scripts/lib/plan-audit.mjs: what a real manager's squad state and plan must
// satisfy, against FPL's own witnesses and against the plan's own numbers.
// The scheduled health probe runs these on a pinned real entry
// (netlify/functions/lib/fpl-health-run.mjs), so each one is shown to pass on
// a real manager AND to fail on the defect it exists for: a check that cannot
// fail is decoration.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { resolveGameState } from '../js/engine/world.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { DEFAULT_SETTINGS } from '../js/ui/store.js';
import { APP_PLAN_SEED } from '../scripts/lib/probe.mjs';
import {
  freeTransferWitnessFailures, chipLedgerFailures, squadReadFailures, planConsistencyFailures,
} from '../scripts/lib/plan-audit.mjs';
import { deadlinePayload } from './helpers/xp-calibration-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

// A real manager at the GW4 deadline of 2026/27, against the payload FPL
// served at that deadline (prices as after GW4; see the fixture's note).
const REAL = read('fixtures', 'real-entry-gw4.json');
const PAYLOAD = deadlinePayload(4);
PAYLOAD.bootstrap.chips = REAL.chips;
const first = buildGameState(PAYLOAD.bootstrap, PAYLOAD.fixtures, { fetchedAt: PAYLOAD.fetchedAt });
const { gameState } = resolveGameState(first, {
  bootstrap: PAYLOAD.bootstrap, fixtures: PAYLOAD.fixtures, fetchedAt: PAYLOAD.fetchedAt,
  kept: null, shipped: read('..', 'data', 'opening-baseline.json'),
});
const rules = gameState.rules;
const squadState = buildSquadState({ ...REAL, gameState, gw: 4 });
// The plan a visitor sees for him: the app's default settings and seed.
const bundle = await buildPlan({
  gameState, squadState,
  options: { horizon: DEFAULT_SETTINGS.horizon, risk: DEFAULT_SETTINGS.risk, seed: APP_PLAN_SEED },
});

const clone = (v) => structuredClone(v);

// ------------------------------------------------------- free transfers ---

test('the owner\'s whole 2026/27 season reproduces every hit FPL charged', () => {
  // Entry 3855835 through GW6, the history behind the 2026-10-09 incident
  // (a GW4 Wildcard, a GW5 Bench Boost with two transfers, one in GW6).
  const history = {
    current: [
      { event: 1, event_transfers: 0, event_transfers_cost: 0 },
      { event: 2, event_transfers: 1, event_transfers_cost: 0 },
      { event: 3, event_transfers: 0, event_transfers_cost: 0 },
      { event: 4, event_transfers: 0, event_transfers_cost: 0 },
      { event: 5, event_transfers: 2, event_transfers_cost: 0 },
      { event: 6, event_transfers: 1, event_transfers_cost: 0 },
    ],
    chips: [{ name: 'wildcard', event: 4 }, { name: 'bboost', event: 5 }],
  };
  assert.deepEqual(freeTransferWitnessFailures({ history, rules }), []);
  assert.deepEqual(freeTransferWitnessFailures({ history: REAL.history, rules }), []);
});

test('a charge the replay cannot reproduce is named by gameweek, in both directions', () => {
  const history = clone(REAL.history);
  // GW2 opens with one free transfer: two transfers there cost 4.
  Object.assign(history.current.find(r => r.event === 2), { event_transfers: 2, event_transfers_cost: 0 });
  assert.deepEqual(freeTransferWitnessFailures({ history, rules }), ['GW2: 2 transfers on 1 free should cost 4, FPL charged 0']);
  // And a hit FPL charged that the replay thought free (the chip-week +1 of
  // 2026-10-09 read this way: a free move FPL charged 4 for).
  Object.assign(history.current.find(r => r.event === 2), { event_transfers: 1, event_transfers_cost: 4 });
  assert.deepEqual(freeTransferWitnessFailures({ history, rules }), ['GW2: 1 transfer on 1 free should cost 0, FPL charged 4']);
});

// ---------------------------------------------------------------- chips ---

test('the chips offered are recomputed from the raw catalogue and the chips played', () => {
  const bootstrap = { chips: REAL.chips };
  const played = { chips: [{ name: 'wildcard', event: 4 }, { name: 'bboost', event: 5 }] };
  assert.deepEqual(chipLedgerFailures({ bootstrap, history: played, offered: ['freehit', '3xc'], gw: 7 }), []);
  assert.deepEqual(chipLedgerFailures({ bootstrap, history: played, offered: ['freehit', '3xc', 'wildcard'], gw: 7 }),
    ['wildcard is offered but was already played in its half, or is out of window']);
  assert.deepEqual(chipLedgerFailures({ bootstrap, history: played, offered: ['3xc'], gw: 7 }),
    ['freehit is unplayed and in window but is not offered']);
  // The second half re-opens every chip.
  assert.deepEqual(chipLedgerFailures({ bootstrap, history: played, offered: ['wildcard', 'freehit', 'bboost', '3xc'], gw: 20 }), []);
  // And the real squad state agrees with the ledger.
  assert.deepEqual(chipLedgerFailures({ bootstrap, history: REAL.history, offered: squadState.chipsAvailable, gw: 4 }), []);
});

// ---------------------------------------------------------------- squad ---

test('the squad read from a real manager agrees with FPL, and a disagreement is reported', () => {
  assert.deepEqual(squadReadFailures({ squadState, picks: REAL.picks, rules }), []);

  const wrongBank = { ...squadState, bankTenths: squadState.bankTenths + 5 };
  assert.match(squadReadFailures({ squadState: wrongBank, picks: REAL.picks, rules })[0], /^bank read as 5 tenths, FPL's picks say 0/);

  // FPL's frozen value one tenth off what the fifteen and the bank add up to.
  const offPicks = clone(REAL.picks);
  offPicks.entry_history.value += 1;
  const off = buildSquadState({ ...REAL, picks: offPicks, gameState, gw: 4 });
  assert.ok(squadReadFailures({ squadState: off, picks: offPicks, rules }).some(f => f.startsWith('value_mismatch')));

  const short = { ...squadState, picks: squadState.picks.slice(1) };
  assert.ok(squadReadFailures({ squadState: short, picks: REAL.picks, rules }).includes('14 players read, expected 15'));
});

// ---------------------------------------------------------- consistency ---

test('a real manager\'s plan agrees with its own numbers', () => {
  assert.deepEqual(planConsistencyFailures({ bundle, squadState, rules }), []);
  assert.ok(bundle.current.alternatives.length > 0, 'the alternatives check had something to judge');
  assert.ok(bundle.future.length === 4, 'and so did the projected chain');
});

test('each consistency rule fails on the contradiction it exists for', () => {
  const failsWith = (mutate, re) => {
    const b = { current: clone(bundle.current), future: clone(bundle.future) };
    mutate(b.current, b);
    const out = planConsistencyFailures({ bundle: b, squadState, rules });
    assert.ok(out.some(f => re.test(f)), `expected ${re} in ${JSON.stringify(out)}`);
  };
  // The Alternatives card of 2026-10-09: a runner-up ranked above the plan.
  failsWith(p => { p.alternatives[0].deltaObjective = 0.4; p.alternatives[0].belowHitMargin = false; }, /ranks 0\.40 above the plan/);
  // A runner-up projecting more, with no flag to say why it lost.
  failsWith(p => {
    Object.assign(p.alternatives[0], { deltaHorizon: 0.3, chip: p.chip, deltaWithChipValue: null, belowHitMargin: false, belowRollValue: false });
  }, /projects 0\.30 more and its card gives no reason/);
  // The headline xP of 2026-09-04: a total that is not its parts.
  failsWith(p => { p.xPointsGw += 1.5; }, /is not the sum of its parts/);
  failsWith(p => { p.bankAfterTenths += 1; }, /^bank after/);
  // The projected chain carries the squad and the bank (2026-10-16): a week
  // selling a player the week before does not own, or a bank that does not add up.
  failsWith((p, b) => { b.future[0].transfersOut = [-1]; }, /sells -1, not in the GW\d+ squad/);
  failsWith((p, b) => { b.future[0].bankAfterTenths += 3; }, /plus its sales less its buys/);
  failsWith(p => { p.freeTransfersAfter += 1; }, /free transfers after/);
  // The chip-week +1 of 2026-10-09, on the plan this manager is told to play.
  assert.equal(bundle.current.chip, 'wildcard', 'the engine recommends the Wildcard he actually played that week');
  failsWith(p => { p.freeTransfersNextGw += 1; }, /after a wildcard, expected the 2 banked/);
  failsWith(p => { p.freeTransfersNextGw += 1; }, /next gameweek starts with/);
  failsWith(p => { p.captain = p.bench.order[0]; }, /captain is not in the eleven/);
  failsWith(p => { p.explanation.headline = 'Roll your transfer'; }, /does not describe/);
  failsWith((p, b) => { b.future[1].freeTransfersAfter += 2; }, /starts with \d+ free transfers, GW\d+ leaves/);
  failsWith(p => { p.squad[0] = 999999; }, /not the held squad|do not partition/);
});
