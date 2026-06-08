// Tests for Item 8: temporary per-session kg/lbs switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkoutSession } from '../js/models/WorkoutSession.js';
import { convertWeight } from '../js/utils/helpers.js';

test('WorkoutSession: sessionUnit defaults to null (follow account unit)', () => {
    const s = new WorkoutSession({});
    assert.equal(s.sessionUnit, null);
});

test('WorkoutSession: sessionUnit round-trips through toJSON/fromJSON', () => {
    const s = new WorkoutSession({ sessionUnit: 'lb' });
    assert.equal(s.sessionUnit, 'lb');
    const back = WorkoutSession.fromJSON(s.toJSON());
    assert.equal(back.sessionUnit, 'lb');
});

test('WorkoutSession: invalid sessionUnit coerces to null', () => {
    const s = new WorkoutSession({ sessionUnit: 'stone' });
    assert.equal(s.sessionUnit, null);
});

test('entry conversion: 100 lb entered with a kg account stores ~45.4 kg', () => {
    // The view converts the entered (session-unit) value into the account unit
    // before storing it on the Set. Verify the underlying conversion.
    const stored = convertWeight(100, 'lb', 'kg');
    assert.ok(Math.abs(stored - 45.4) < 0.1, `expected ~45.4, got ${stored}`);
});

test('entry conversion round-trip: display matches what was entered', () => {
    // Account unit kg, session unit lb. Enter 135 lb -> store kg -> show back lb.
    const account = 'kg';
    const session = 'lb';
    const entered = 135;
    const canonical = convertWeight(entered, session, account);
    const shownBack = convertWeight(canonical, account, session);
    // Round-trip should land within 1 unit (rounding to 1 decimal each way).
    assert.ok(Math.abs(shownBack - entered) < 1, `round-trip drifted: ${shownBack} vs ${entered}`);
});

test('same-unit conversion is a no-op', () => {
    assert.equal(convertWeight(60, 'kg', 'kg'), 60);
});
