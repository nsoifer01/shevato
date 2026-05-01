process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    on, off, once, emit, EVENTS, _clearAllListenersForTesting,
} from '../js/utils/event-bus.js';

test('on/emit: payload reaches the subscriber', () => {
    _clearAllListenersForTesting();
    let got = null;
    on('test:hello', (payload) => { got = payload; });
    emit('test:hello', { v: 42 });
    assert.deepEqual(got, { v: 42 });
});

test('on returns an off function that detaches the listener', () => {
    _clearAllListenersForTesting();
    let calls = 0;
    const off1 = on('test:event', () => { calls++; });
    emit('test:event');
    off1();
    emit('test:event');
    assert.equal(calls, 1);
});

test('off: removes a specific listener', () => {
    _clearAllListenersForTesting();
    let a = 0, b = 0;
    const fnA = () => { a++; };
    const fnB = () => { b++; };
    on('test:event', fnA);
    on('test:event', fnB);
    off('test:event', fnA);
    emit('test:event');
    assert.equal(a, 0);
    assert.equal(b, 1);
});

test('once: fires exactly one time then auto-detaches', () => {
    _clearAllListenersForTesting();
    let calls = 0;
    once('test:event', () => { calls++; });
    emit('test:event');
    emit('test:event');
    emit('test:event');
    assert.equal(calls, 1);
});

test('emit: throwing listener does not stop other listeners', () => {
    _clearAllListenersForTesting();
    let calls = 0;
    on('test:event', () => { throw new Error('boom'); });
    on('test:event', () => { calls++; });
    // Suppress console.error spam during the test
    const origErr = console.error;
    console.error = () => {};
    try {
        emit('test:event');
    } finally {
        console.error = origErr;
    }
    assert.equal(calls, 1);
});

test('emit: a listener that off()s itself mid-dispatch does not break iteration', () => {
    _clearAllListenersForTesting();
    let total = 0;
    const fnA = () => { total++; off('test:event', fnA); };
    const fnB = () => { total++; };
    on('test:event', fnA);
    on('test:event', fnB);
    emit('test:event');
    assert.equal(total, 2);
});

test('EVENTS export is frozen so it cannot be mutated by callers', () => {
    assert.ok(Object.isFrozen(EVENTS));
    assert.equal(typeof EVENTS.PROGRAMS_CHANGED, 'string');
});
