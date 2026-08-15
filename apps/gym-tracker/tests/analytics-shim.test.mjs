// The gym-tracker analytics bridge (js/utils/analytics.js).
//
// Why it matters: the shared site helper (window.shevatoAnalytics) is
// installed by a DEFERRED classic script, so it may not exist yet when a
// module calls track(), may never exist (blocked, script error), or may
// throw internally. None of that may ever surface as a broken workout - the
// bridge must resolve the helper at call time and swallow everything.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
const { track } = await import('../js/utils/analytics.js');

test('track: missing window.shevatoAnalytics never throws', () => {
    delete globalThis.window.shevatoAnalytics;
    assert.doesNotThrow(() => track('trackEvent', 'workout_finished', { sets: 12 }));
});

test('track: a throwing helper implementation never propagates', () => {
    globalThis.window.shevatoAnalytics = {
        trackEvent: () => { throw new Error('ga4 exploded'); },
    };
    assert.doesNotThrow(() => track('trackEvent', 'workout_finished'));
});

test('track: a non-function member is ignored, not called', () => {
    globalThis.window.shevatoAnalytics = { trackEvent: 'not-a-function' };
    assert.doesNotThrow(() => track('trackEvent', 'x'));
});

test('track: an unknown method name on a present helper is a silent no-op', () => {
    const calls = [];
    globalThis.window.shevatoAnalytics = { trackEvent: (...a) => calls.push(a) };
    assert.doesNotThrow(() => track('noSuchMethod', 1, 2));
    assert.deepEqual(calls, [], 'nothing else was invoked');
});

test('track: late resolution works - the helper appearing AFTER import is picked up', () => {
    // This is the deferred-script race the bridge exists for: module
    // evaluation (and early track calls) can beat the analytics script.
    delete globalThis.window.shevatoAnalytics;
    track('trackEvent', 'lost-before-helper-loaded'); // swallowed
    const calls = [];
    globalThis.window.shevatoAnalytics = { trackEvent: (...a) => calls.push(a) };
    track('trackEvent', 'view_open', { view: 'workout' });
    assert.deepEqual(calls, [['view_open', { view: 'workout' }]],
        'arguments forwarded verbatim once the helper exists');
});

test('track: no window at all (non-browser caller) stays silent', async () => {
    // The bridge checks typeof window !== 'undefined'; simulate by deleting
    // the stub in a subprocess-like isolation: here we can only null the ref
    // the bridge reads through, which is the same code path.
    const saved = globalThis.window;
    try {
        delete globalThis.window;
        assert.doesNotThrow(() => track('trackEvent', 'x'));
    } finally {
        globalThis.window = saved;
    }
});
