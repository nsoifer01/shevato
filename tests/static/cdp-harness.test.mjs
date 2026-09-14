// The browser driver's own contracts.
//
// tests/browser/cdp.mjs is the harness every browser suite runs through, and it
// is not itself covered by any of them: a defect in the driver shows up as an
// unrelated suite failing somewhere else, which is exactly how the one below
// stayed hidden.
//
// waitForExpr documents "false on timeout - callers assert on the result, so a
// wait that never comes fails the check rather than throwing the suite over".
// That held for a condition that never became true, but not for the transport.
// When the renderer is busy enough that Runtime.evaluate hits the driver's own
// 45 s send timeout, the rejection propagated out of waitForExpr and killed
// whatever section was running. On CI that took out an entire Globe Drop block,
// which then reported only "ran to completion false" - a whole scenario's worth
// of coverage silently gone, on a suite that passed locally every time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForExpr, probe, evaluate } from '../browser/cdp.mjs';

// A Session stand-in: `send` is the only thing waitForExpr reaches, through
// evaluate(). Each entry in `script` is what the next Runtime.evaluate does.
function fakeSession(script) {
  const calls = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      if (step instanceof Error) throw step;
      return { result: { value: JSON.stringify(step) } };
    },
  };
}

const sendTimeout = () => new Error('timeout: Runtime.evaluate');

test('waitForExpr: a truthy expression returns true on the first poll', async () => {
  const s = fakeSession([true]);
  assert.equal(await waitForExpr(s, 'x', { timeout: 500, poll: 10 }), true);
  assert.equal(s.calls.length, 1);
});

test('waitForExpr: a condition that never comes returns false, it does not throw', async () => {
  const s = fakeSession([false]);
  assert.equal(await waitForExpr(s, 'x', { timeout: 120, poll: 10 }), false);
});

test('waitForExpr: a send timeout is a slow poll, not a thrown suite', async () => {
  // One transport timeout, then the condition is true. Before the fix this
  // rejected and took the caller's whole section with it.
  const s = fakeSession([sendTimeout(), true]);
  assert.equal(await waitForExpr(s, 'x', { timeout: 5000, poll: 10 }), true,
    'polling must continue past a send timeout and still see the condition');
});

test('waitForExpr: send timeouts all the way to the deadline return false', async () => {
  const s = fakeSession([sendTimeout()]);
  assert.equal(await waitForExpr(s, 'x', { timeout: 120, poll: 10 }), false,
    'the caller asserts on false; it must not have to catch');
});

test('waitForExpr: a REAL page error still throws', async () => {
  // Not something waiting longer can fix - a closed target, a detached
  // session. Absorbing these would turn a broken harness into a silent false.
  const s = fakeSession([new Error('Session closed. Most likely the page has been closed.')]);
  await assert.rejects(
    () => waitForExpr(s, 'x', { timeout: 200, poll: 10 }),
    /Session closed/,
  );
});

test('waitForExpr: an in-page exception is falsy, not fatal', async () => {
  // evaluate() maps a thrown expression to { __evalError }, which means "not
  // ready yet" (the element does not exist yet), not "give up".
  const s = fakeSession([{ __evalError: 'x is not defined' }]);
  assert.equal(await waitForExpr(s, 'x', { timeout: 120, poll: 10 }), false);
});

// probe(): the same rule for polling loops that are not waitForExpr. The Arena
// e2e's advanceThroughPick polled with plain evaluate(), so one page too busy
// to answer a single read within 45 s threw the whole S5 scenario away on the
// scheduled run of 2026-09-14.
test('probe: a value comes back as a value', async () => {
  const s = fakeSession([{ ready: true }]);
  assert.deepEqual(await probe(s, 'x'), { ready: true });
});

test('probe: a send timeout is "not known yet" (null), never a thrown scenario', async () => {
  const s = fakeSession([sendTimeout()]);
  assert.equal(await probe(s, 'x'), null);
});

test('probe: a REAL page error still throws', async () => {
  const s = fakeSession([new Error('Target closed')]);
  await assert.rejects(() => probe(s, 'x'), /Target closed/);
});

test('evaluate: a send timeout names the page and the read, and keeps its prefix', async () => {
  const s = fakeSession([sendTimeout()]);
  s.lastUrl = 'http://localhost:8137/apps/arena/';
  const err = await evaluate(s, "document.getElementById('question-text').textContent").catch((e) => e);
  assert.match(err.message, /^timeout: Runtime\.evaluate/, 'callers recognise a send timeout by this prefix');
  assert.match(err.message, /on http:\/\/localhost:8137\/apps\/arena\//);
  assert.match(err.message, /question-text/);
});
