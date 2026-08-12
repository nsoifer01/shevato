// The free-transfer allowance, tested as SEQUENCES rather than snapshots.
//
// This file exists because a suite of 3000+ passing assertions did not catch a
// season-long off-by-one. Every one of them asked "is this state legal" (0 <=
// ft <= cap, hits priced at 4, plan validates) and legality is preserved by the
// bug: a manager carrying one extra free transfer all season is legal in every
// single gameweek and wrong in every single gameweek.
//
// So each test here WALKS a season and asserts the value at every step. If a
// transition changes, one of these has to fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import {
  UNLIMITED,
  initialTransferState,
  advance,
  freeTransfersFor,
  hitCost,
  isUnlimited,
  transferAccounting,
  transferStateOf,
  replayTransferState,
  formatFreeTransfers,
} from '../js/engine/transfer-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const bootstrap = JSON.parse(readFileSync(join(here, 'fixtures', 'bootstrap.json'), 'utf8'));
const rules = buildRules(bootstrap);

// Walk a season and collect the allowance going into each gameweek. `plan(gw)`
// returns what the manager did in that gameweek.
function walk({ from = 1, to, plan = () => ({}) } = {}) {
  let state = initialTransferState({ gw: from });
  const seen = [];
  for (let gw = from; gw <= to; gw++) {
    seen.push(freeTransfersFor(state));
    const { transfersMade = 0, chipPlayed = null, recorded = true } = plan(gw) || {};
    state = advance(state, { gw, transfersMade, chipPlayed, rules, recorded });
  }
  return { seen, state };
}

// ---------------------------------------------------------------- pre-season

test('pre-season is unlimited, and unlimited is not the number five', () => {
  const state = initialTransferState();
  assert.equal(freeTransfersFor(state), UNLIMITED);
  assert.ok(isUnlimited(state));
  assert.ok(!Number.isFinite(freeTransfersFor(state)));

  // The defect this replaces: `freeTransfers: rules.maxFreeTransfers`.
  assert.notEqual(freeTransfersFor(state), rules.maxFreeTransfers);
  assert.notEqual(freeTransfersFor(state), 5);
  assert.notEqual(freeTransfersFor(state), 1);

  // And it costs nothing to make any number of changes before the deadline.
  assert.equal(hitCost(state, 15, rules), 0);
  assert.equal(hitCost(state, 100, rules), 0);
});

test('past the GW1 deadline the allowance is exactly one, however pre-season went', () => {
  for (const transfersMade of [0, 1, 5, 15]) {
    const next = advance(initialTransferState({ gw: 1 }), { gw: 1, transfersMade, rules });
    assert.equal(freeTransfersFor(next), 1, `${transfersMade} pre-season changes still leaves 1`);
    assert.ok(!isUnlimited(next), 'and the unlimited phase is over');
  }
});

test('unlimited does not roll over: the first gameweek after the deadline is 1, not 2 and not the cap', () => {
  const { seen } = walk({ to: 2 });
  assert.deepEqual(seen, [UNLIMITED, 1]);
});

// ------------------------------------------------------------- the rollover

test('a manager who never transfers rolls 1, 2, 3, 4, 5 and then holds at 5', () => {
  const { seen } = walk({ to: 12 });
  assert.deepEqual(seen, [UNLIMITED, 1, 2, 3, 4, 5, 5, 5, 5, 5, 5, 5]);

  // Stated again as the individual claims, because this is the arithmetic that
  // was wrong for the whole season: it read 2, 3, 4, 5 from gameweek 2.
  assert.equal(seen[1], 1, 'into GW2');
  assert.equal(seen[2], 2, 'into GW3');
  assert.equal(seen[3], 3, 'into GW4');
  assert.equal(seen[4], 4, 'into GW5');
  assert.equal(seen[5], 5, 'into GW6');
  assert.equal(seen[6], 5, 'into GW7, the cap holds');
});

test('the cap is a ceiling on banking, not a number the game ever pays out', () => {
  // Sitting at the cap and spending nothing stays at the cap: the arriving
  // transfer is lost, it does not accumulate.
  let state = { phase: 'season', gw: 10, banked: rules.maxFreeTransfers };
  for (let gw = 10; gw < 20; gw++) {
    state = advance(state, { gw, transfersMade: 0, rules });
    assert.equal(freeTransfersFor(state), rules.maxFreeTransfers);
  }
});

test('spending from a bank of 2 lands on the right value the following gameweek', () => {
  const two = { phase: 'season', gw: 5, banked: 2 };

  const usedOne = advance(two, { gw: 5, transfersMade: 1, rules });
  assert.equal(freeTransfersFor(usedOne), 2, '2 banked, 1 used, leaves 1, plus the new one is 2');

  const usedBoth = advance(two, { gw: 5, transfersMade: 2, rules });
  assert.equal(freeTransfersFor(usedBoth), 1, '2 banked, 2 used, leaves 0, plus the new one is 1');

  const usedNone = advance(two, { gw: 5, transfersMade: 0, rules });
  assert.equal(freeTransfersFor(usedNone), 3);
});

test('spending from a full bank of 5, including beyond it, never goes negative', () => {
  const five = { phase: 'season', gw: 20, banked: 5 };
  assert.equal(freeTransfersFor(advance(five, { gw: 20, transfersMade: 3, rules })), 3);
  assert.equal(freeTransfersFor(advance(five, { gw: 20, transfersMade: 5, rules })), 1);
  // Two hits on top of the five: the bank cannot go below zero, so next
  // gameweek is the single arriving transfer.
  assert.equal(freeTransfersFor(advance(five, { gw: 20, transfersMade: 7, rules })), 1);
});

// ------------------------------------------------------------------- hits

test('transfers within the allowance cost nothing and every one beyond it costs exactly four', () => {
  const three = { phase: 'season', gw: 8, banked: 3 };
  assert.equal(hitCost(three, 0, rules), 0);
  assert.equal(hitCost(three, 1, rules), 0);
  assert.equal(hitCost(three, 3, rules), 0);
  assert.equal(hitCost(three, 4, rules), rules.hitCost);
  assert.equal(hitCost(three, 5, rules), 2 * rules.hitCost);
  assert.equal(hitCost(three, 8, rules), 5 * rules.hitCost);
  assert.equal(rules.hitCost, 4, 'and the rate itself is four points');

  const none = { phase: 'season', gw: 8, banked: 0 };
  assert.equal(hitCost(none, 0, rules), 0);
  assert.equal(hitCost(none, 1, rules), 4);
  assert.equal(hitCost(none, 2, rules), 8);
});

test('the accounting a plan reports is internally consistent at every bank level', () => {
  for (let banked = 0; banked <= rules.maxFreeTransfers; banked++) {
    for (let made = 0; made <= 6; made++) {
      const state = { phase: 'season', gw: 9, banked };
      const acct = transferAccounting({ state, transfersMade: made, rules });
      assert.equal(acct.freeTransfersUsed + acct.hits, made, `${banked}/${made}: every transfer is free or a hit`);
      assert.equal(acct.freeTransfersUsed, Math.min(made, banked));
      assert.equal(acct.freeTransfersAfter, banked - acct.freeTransfersUsed);
      assert.equal(acct.hitCostPoints, acct.hits * rules.hitCost);
      assert.equal(
        acct.freeTransfersNextGw,
        Math.min(rules.maxFreeTransfers, acct.freeTransfersAfter + 1),
        'and next gameweek is what is left plus the arriving one, capped',
      );
    }
  }
});

// ------------------------------------------------------------------- chips

test('a wildcard week is free and unlimited, keeps the bank, and the usual +1 still arrives', () => {
  const two = { phase: 'season', gw: 6, banked: 2 };
  const acct = transferAccounting({ state: two, transfersMade: 11, chipPlayed: 'wildcard', rules });

  assert.equal(acct.hits, 0, 'unlimited');
  assert.equal(acct.hitCostPoints, 0, 'and free');
  assert.equal(acct.freeTransfersUsed, 0, 'a wildcard spends no banked transfer');
  assert.equal(acct.freeTransfersAfter, 2, 'the bank is preserved');
  assert.equal(acct.freeTransfersNextGw, 3, 'and the usual one arrives on top of it');

  const next = advance(two, { gw: 6, transfersMade: 11, chipPlayed: 'wildcard', rules });
  assert.equal(freeTransfersFor(next), 3);
  // The week after that behaves normally again.
  assert.equal(freeTransfersFor(advance(next, { gw: 7, transfersMade: 1, rules })), 3);
});

test('a free hit week is treated the same, and the squad reverting does not change the allowance', () => {
  const three = { phase: 'season', gw: 18, banked: 3 };
  const acct = transferAccounting({ state: three, transfersMade: 9, chipPlayed: 'freehit', rules });
  assert.equal(acct.hits, 0);
  assert.equal(acct.hitCostPoints, 0);
  assert.equal(acct.freeTransfersUsed, 0);
  assert.equal(acct.freeTransfersAfter, 3);
  assert.equal(acct.freeTransfersNextGw, 4);

  // The rented squad is handed back, so the 9 transfers are not carried into
  // the next gameweek's arithmetic in any form.
  const next = advance(three, { gw: 18, transfersMade: 9, chipPlayed: 'freehit', rules });
  assert.equal(freeTransfersFor(next), 4);
  assert.equal(freeTransfersFor(advance(next, { gw: 19, transfersMade: 0, rules })), 5);
});

test('a bench boost or triple captain week is an ordinary transfer week', () => {
  const two = { phase: 'season', gw: 12, banked: 2 };
  for (const chipPlayed of ['bboost', '3xc']) {
    assert.equal(hitCost(two, 4, rules, chipPlayed), 2 * rules.hitCost, `${chipPlayed} does not make transfers free`);
    assert.equal(freeTransfersFor(advance(two, { gw: 12, transfersMade: 2, chipPlayed, rules })), 1);
  }
});

test('a chip in the pre-season week still leaves exactly one for the gameweek after', () => {
  const next = advance(initialTransferState({ gw: 1 }), { gw: 1, transfersMade: 15, chipPlayed: 'wildcard', rules });
  assert.equal(freeTransfersFor(next), 1, 'unlimited plus a chip is still not more than one afterwards');
});

// ------------------------------------------------------------ a whole season

test('a season of real behaviour walks the exact sequence, gameweek by gameweek', () => {
  // GW1 build (unlimited), GW2 roll, GW3 roll, GW4 two transfers from a bank of
  // 3, GW5 roll, GW6 wildcard with eight moves, GW7 one transfer, GW8 three
  // transfers from a bank of 2 (one hit), GW9 roll.
  const script = {
    1: { transfersMade: 15 },
    4: { transfersMade: 2 },
    6: { transfersMade: 8, chipPlayed: 'wildcard' },
    7: { transfersMade: 1 },
    8: { transfersMade: 3 },
  };
  const { seen } = walk({ to: 10, plan: gw => script[gw] });

  assert.deepEqual(seen, [
    UNLIMITED, // GW1, before the first deadline
    1,         // GW2
    2,         // GW3
    3,         // GW4, two spent
    2,         // GW5
    3,         // GW6, wildcard, nothing spent
    4,         // GW7, one spent
    4,         // GW8, three spent against 4
    2,         // GW9
    3,         // GW10
  ]);

  // And the one hit in that season is the eighth gameweek, charged once.
  assert.equal(hitCost({ phase: 'season', gw: 8, banked: 4 }, 3, rules), 0);
  assert.equal(hitCost({ phase: 'season', gw: 8, banked: 2 }, 3, rules), rules.hitCost);
});

// ------------------------------------------------------------ replay from API

test('replaying a history walks the same sequence the state machine does', () => {
  const current = [];
  for (let gw = 1; gw <= 10; gw++) current.push({ event: gw, event_transfers: 0 });
  const history = { current, chips: [] };

  const expected = [UNLIMITED, 1, 2, 3, 4, 5, 5, 5, 5, 5, 5];
  for (let upToGw = 1; upToGw <= 11; upToGw++) {
    assert.equal(
      freeTransfersFor(replayTransferState({ history, rules, upToGw })),
      expected[upToGw - 1],
      `into GW${upToGw}`,
    );
  }
});

test('a manager who joins late starts his own pre-season, then one per gameweek', () => {
  const history = {
    current: [
      { event: 7, event_transfers: 15 },
      { event: 8, event_transfers: 0 },
      { event: 9, event_transfers: 0 },
    ],
    chips: [],
  };
  // His first deadline is GW7's, so GW7 itself is unlimited and GW8 is his first
  // single free transfer.
  assert.ok(isUnlimited(replayTransferState({ history, rules, upToGw: 7 })));
  assert.equal(freeTransfersFor(replayTransferState({ history, rules, upToGw: 8 })), 1);
  assert.equal(freeTransfersFor(replayTransferState({ history, rules, upToGw: 9 })), 2);
  assert.equal(freeTransfersFor(replayTransferState({ history, rules, upToGw: 10 })), 3);
});

test('a gameweek missing from history never inflates the count', () => {
  const complete = {
    current: [
      { event: 1, event_transfers: 0 },
      { event: 2, event_transfers: 0 },
      { event: 3, event_transfers: 0 },
      { event: 4, event_transfers: 0 },
    ],
    chips: [],
  };
  // The same manager, on a payload that has not caught up: gameweeks 3 and 4
  // are missing entirely.
  const lagging = { current: complete.current.slice(0, 2), chips: [] };

  const full = freeTransfersFor(replayTransferState({ history: complete, rules, upToGw: 5 }));
  const lagged = freeTransfersFor(replayTransferState({ history: lagging, rules, upToGw: 5 }));
  assert.equal(full, 4);
  assert.ok(lagged <= full, 'a lagging payload may under-report, never over-report');
  assert.equal(lagged, 2, 'the two unknown gameweeks neither bank nor spend');

  // A hole in the middle behaves the same way.
  const holed = {
    current: [
      { event: 1, event_transfers: 0 },
      { event: 2, event_transfers: 0 },
      { event: 4, event_transfers: 0 },
    ],
    chips: [],
  };
  assert.equal(freeTransfersFor(replayTransferState({ history: holed, rules, upToGw: 5 })), 3);
});

test('hits inside the replayed history cannot drive the count below zero', () => {
  const history = {
    current: [
      { event: 1, event_transfers: 0 },
      { event: 2, event_transfers: 6, event_transfers_cost: 20 },
      { event: 3, event_transfers: 4, event_transfers_cost: 12 },
    ],
    chips: [],
  };
  assert.equal(freeTransfersFor(replayTransferState({ history, rules, upToGw: 3 })), 1);
  assert.equal(freeTransfersFor(replayTransferState({ history, rules, upToGw: 4 })), 1);
});

test('a wildcard inside the replayed history preserves the bank across it', () => {
  const current = [
    { event: 1, event_transfers: 0 },
    { event: 2, event_transfers: 0 },
    { event: 3, event_transfers: 0 },
    { event: 4, event_transfers: 12 },
    { event: 5, event_transfers: 0 },
  ];
  const withChip = { current, chips: [{ name: 'wildcard', event: 4 }] };
  const withoutChip = { current, chips: [] };

  // Into GW4 the manager has 3 banked either way.
  assert.equal(freeTransfersFor(replayTransferState({ history: withChip, rules, upToGw: 4 })), 3);
  // The wildcard keeps all three and adds one; without it, twelve transfers
  // empty the bank and only the arriving one is left.
  assert.equal(freeTransfersFor(replayTransferState({ history: withChip, rules, upToGw: 5 })), 4);
  assert.equal(freeTransfersFor(replayTransferState({ history: withoutChip, rules, upToGw: 5 })), 1);
  assert.equal(freeTransfersFor(replayTransferState({ history: withChip, rules, upToGw: 6 })), 5);
});

// ------------------------------------------------------------------ adapters

test('a squad state carrying only a number is read back into the same state', () => {
  for (let banked = 0; banked <= rules.maxFreeTransfers; banked++) {
    assert.equal(freeTransfersFor(transferStateOf({ gw: 6, freeTransfers: banked }, rules)), banked);
  }
  assert.ok(isUnlimited(transferStateOf({ gw: 1, freeTransfers: UNLIMITED }, rules)));
  // Absent, which is what a bare fixture looks like: the guaranteed floor.
  assert.equal(freeTransfersFor(transferStateOf({ gw: 6 }, rules)), 1);
  // A state already on the squad wins over the number beside it.
  const state = { phase: 'season', gw: 6, banked: 4 };
  assert.equal(freeTransfersFor(transferStateOf({ gw: 6, freeTransfers: 1, transferState: state }, rules)), 4);
});

test('the pre-season allowance is displayed as a word, never as the cap', () => {
  assert.equal(formatFreeTransfers(UNLIMITED), 'Unlimited');
  assert.equal(formatFreeTransfers(UNLIMITED, { untilGw: 1 }), 'Unlimited until the GW1 deadline');
  assert.equal(formatFreeTransfers(0), '0');
  assert.equal(formatFreeTransfers(1), '1');
  assert.equal(formatFreeTransfers(5), '5');
  assert.notEqual(formatFreeTransfers(UNLIMITED), '5');
});

// ------------------------------------------------------------- rule sourcing

test('the cap comes from the game settings, and a different cap changes the sequence', () => {
  assert.equal(rules.maxFreeTransfers, 5, '1 + max_extra_free_transfers under the current settings');

  // The pre-2024 rules, where only one transfer could be banked. The same
  // sequence must respect it without a line of this module knowing the number.
  const oldRules = { ...rules, maxFreeTransfers: 2 };
  let state = initialTransferState({ gw: 1 });
  const seen = [];
  for (let gw = 1; gw <= 6; gw++) {
    seen.push(freeTransfersFor(state));
    state = advance(state, { gw, transfersMade: 0, rules: oldRules });
  }
  assert.deepEqual(seen, [UNLIMITED, 1, 2, 2, 2, 2]);
});

// ---------------------------------------------------------------------------
// Era rules. The engine defaults reproduce the LIVE game; a historical rules
// object (scripts/backtest.mjs historicalRules) switches on the season the
// replay is scoring, and these walks pin each behaviour as a sequence.
// ---------------------------------------------------------------------------

test('a 2-cap era banks to two and never three', () => {
  const era = { ...rules, maxFreeTransfers: 2 };
  let state = initialTransferState({ gw: 1 });
  state = advance(state, { gw: 1, transfersMade: 0, rules: era });   // -> gw2, 1 FT
  assert.equal(freeTransfersFor(state), 1);
  state = advance(state, { gw: 2, transfersMade: 0, rules: era });   // -> gw3, 2 FT
  assert.equal(freeTransfersFor(state), 2);
  state = advance(state, { gw: 3, transfersMade: 0, rules: era });   // -> gw4, capped
  assert.equal(freeTransfersFor(state), 2, 'the 2-cap era cannot bank a third');
});

test('before 2024-25 a chip week could not bank: the next week starts at one', () => {
  const era = { ...rules, maxFreeTransfers: 2, chipPreservesBank: false };
  let state = initialTransferState({ gw: 1 });
  state = advance(state, { gw: 1, transfersMade: 0, rules: era });
  state = advance(state, { gw: 2, transfersMade: 0, rules: era });
  assert.equal(freeTransfersFor(state), 2, 'two banked going into the chip week');
  state = advance(state, { gw: 3, transfersMade: 4, chipPlayed: 'wildcard', rules: era });
  assert.equal(freeTransfersFor(state), 1, 'the old rule resets the week after a chip');

  // And the modern default on the same walk preserves the bank.
  let modern = initialTransferState({ gw: 1 });
  modern = advance(modern, { gw: 1, transfersMade: 0, rules });
  modern = advance(modern, { gw: 2, transfersMade: 0, rules });
  modern = advance(modern, { gw: 3, transfersMade: 4, chipPlayed: 'wildcard', rules });
  assert.equal(freeTransfersFor(modern), Math.min(rules.maxFreeTransfers, 2 + 1));
});

test('an unlimited event mid-season: unlimited that week, exactly one after', () => {
  // The 2022-23 World Cup break: unlimited transfers between the gameweek 16
  // and 17 deadlines, then the count restarts at one for gameweek 18.
  const era = { ...rules, maxFreeTransfers: 2, unlimitedEvents: [17] };
  let state = initialTransferState({ gw: 1 });
  for (let gw = 1; gw <= 15; gw++) state = advance(state, { gw, transfersMade: 1, rules: era });
  assert.equal(freeTransfersFor(state), 1, 'a transfer a week holds the count at one');
  state = advance(state, { gw: 16, transfersMade: 0, rules: era });
  assert.ok(!Number.isFinite(freeTransfersFor(state)), 'gameweek 17 is unlimited');
  assert.ok(isUnlimited(state));
  // Unlimited transfers cost nothing whatever their number.
  assert.equal(hitCost(state, 9, era), 0);
  state = advance(state, { gw: 17, transfersMade: 9, rules: era });
  assert.equal(freeTransfersFor(state), 1, 'and gameweek 18 starts at exactly one');
  // Banking resumes normally afterwards.
  state = advance(state, { gw: 18, transfersMade: 0, rules: era });
  assert.equal(freeTransfersFor(state), 2);
});

test('a rules object that has never heard of the era flags is the live game', () => {
  // The exact walk the modern game produces, with the flags absent rather than
  // set to their defaults, because every live payload is in that state.
  let state = initialTransferState({ gw: 1 });
  for (let gw = 1; gw <= 6; gw++) state = advance(state, { gw, transfersMade: 0, rules });
  assert.equal(freeTransfersFor(state), Math.min(rules.maxFreeTransfers, 6));
});
