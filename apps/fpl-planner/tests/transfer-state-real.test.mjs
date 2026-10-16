// The free-transfer state machine against 411 REAL managers' seasons.
//
// The sequence tests in transfer-state.test.mjs check the code against its
// author's reading of the rules, which is how a Wildcard week came to grant a
// free transfer for a month with every test green (FINDINGS, "A Wildcard or
// Free Hit week granted a free transfer it does not earn"). FPL publishes no
// free-transfer count, but it does publish the hit it charged every gameweek,
// and that is set by the count it held. This file holds the replay to every
// one of those charges for 411 managers sampled on 2026-10-16 across the whole
// overall league (tests/fixtures/real-histories-2026-gw6.json), 2,454
// gameweeks including 325 Wildcard or Free Hit weeks, and shows the check is
// strong enough to reject the rules this module has already got wrong once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRules } from '../js/engine/rules.js';
import { chargedHitDisagreements, replayTransferState, freeTransfersFor } from '../js/engine/transfer-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));
const RULES = buildRules(read('fixtures', 'bootstrap.json'));
const { managers } = read('fixtures', 'real-histories-2026-gw6.json');
const histories = managers.map(m => ({
  current: m.rows.map(([event, transfers, cost]) => ({ event, event_transfers: transfers, event_transfers_cost: cost })),
  chips: m.chips.map(([name, event]) => ({ name, event })),
}));

const disagreements = (rules) => histories.flatMap(history => chargedHitDisagreements({ history, rules }));

test('the replay reproduces every hit FPL charged, for all 411 managers', () => {
  assert.equal(histories.length, 411);
  assert.equal(histories.reduce((n, h) => n + h.current.length, 0), 2454);
  assert.deepEqual(disagreements(RULES), []);
});

test('every GW7 count is a count FPL could hold', () => {
  for (const history of histories) {
    const ft = freeTransfersFor(replayTransferState({ history, rules: RULES, upToGw: 7 }));
    assert.ok(Number.isInteger(ft) && ft >= 1 && ft <= RULES.maxFreeTransfers, `${ft}`);
  }
});

test('the witness is strong enough to reject a wrong rule', () => {
  // The pre-2024-25 chip rule (a Wildcard or Free Hit week resets the bank
  // to one) and the old two-transfer cap each disagree with what FPL charged.
  assert.ok(disagreements({ ...RULES, chipPreservesBank: false }).length >= 10, 'a chip week that resets the bank');
  assert.ok(disagreements({ ...RULES, maxFreeTransfers: 2 }).length >= 10, 'a cap of two');
});
