// When the health probe may report a stale proxy answer instead of failing on
// it (ledger row 48). The header sets are the ones the proxy really sent in the
// incident of 2026-11-09 18:41 UTC (fpl-health report in issue #655), and in a
// real block, where nothing is fetched fresh (2026-10-16, 28 of 28 refused).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { refusedWhileFplAnswered } from '../scripts/lib/probe.mjs';

const headers = (o) => new Headers(o);
const refused = headers({ 'x-fpl-stale': 'true', 'x-fpl-upstream': 'refused', 'x-fpl-cache': 'hit' });
const backingOff = headers({ 'x-fpl-stale': 'true', 'x-fpl-upstream': 'backoff', 'x-fpl-cache': 'hit' });
const freshFromFpl = headers({ 'x-fpl-stale': 'false', 'x-fpl-cache': 'miss' });
const freshFromCache = headers({ 'x-fpl-stale': 'false', 'x-fpl-cache': 'hit' });

test('the 2026-11-09 shape: two refused reads beside others fetched fresh are not a failure', () => {
  const responses = { history: refused, transfers: refused, entry: freshFromFpl, picks: freshFromFpl };
  assert.equal(refusedWhileFplAnswered(refused, responses), true);
});

test('a read inside the backoff that one refusal started is the same event', () => {
  const responses = { picks: backingOff, history: refused, fixtures: freshFromFpl };
  assert.equal(refusedWhileFplAnswered(backingOff, responses), true);
});

test('a block stays a failure: every read refused, nothing fetched fresh', () => {
  const responses = { bootstrap: refused, fixtures: backingOff, entry: backingOff };
  assert.equal(refusedWhileFplAnswered(refused, responses), false);
});

test('a copy that was merely cached proves nothing about FPL answering', () => {
  const responses = { history: refused, entry: freshFromCache };
  assert.equal(refusedWhileFplAnswered(refused, responses), false);
});

test('only a refusal is waived, whatever else the run fetched', () => {
  const responses = { entry: freshFromFpl };
  for (const cause of ['error', 'refreshing', 'quota', null]) {
    const h = headers({ 'x-fpl-stale': 'true', ...(cause ? { 'x-fpl-upstream': cause } : {}) });
    assert.equal(refusedWhileFplAnswered(h, { ...responses, it: h }), false, String(cause));
  }
});

test('an answer that is not stale is never waived', () => {
  assert.equal(refusedWhileFplAnswered(freshFromFpl, { entry: freshFromFpl }), false);
});
