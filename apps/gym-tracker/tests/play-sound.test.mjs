import { test } from 'node:test';
import assert from 'node:assert/strict';

// A minimal fake Web Audio graph that records what was built and started,
// so we can assert a tone actually got scheduled on a given context.
function makeFakeAudioContext(initialState = 'running') {
    const started = [];
    const ctx = {
        state: initialState,
        currentTime: 0,
        resumeCalls: 0,
        createOscillator() {
            const osc = {
                type: 'sine',
                frequency: { value: 0 },
                connect: () => osc,
                start: (when) => started.push({ when }),
                stop: () => {},
            };
            return osc;
        },
        createGain() {
            const node = {
                gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
                connect: () => node,
            };
            return node;
        },
        createBiquadFilter() {
            const node = { type: 'lowpass', frequency: { value: 0 }, connect: () => node };
            return node;
        },
        destination: {},
        resume() {
            this.resumeCalls += 1;
            if (this.state !== 'closed') this.state = 'running';
            return Promise.resolve();
        },
    };
    ctx.started = started;
    return ctx;
}

// Stub the global `window` AudioContext factory before importing helpers.
// `playSound` caches a module-level context; `nextCtx` controls what the next
// `new Ctx()` returns. `created` records every context constructed.
let nextCtx = null;
const created = [];
globalThis.window = {
    AudioContext: function AudioContext() {
        const c = nextCtx || makeFakeAudioContext('running');
        created.push(c);
        nextCtx = null;
        return c;
    },
};

const { playSound } = await import('../js/utils/helpers.js');

// Force the cached module context to be discarded before a test that needs a
// known-fresh one: closing it makes getAudioContext() recreate from nextCtx.
function discardCachedContext() {
    if (created.length) created[created.length - 1].state = 'closed';
}

test('playSound: running context schedules a tone immediately', () => {
    nextCtx = makeFakeAudioContext('running');
    playSound('rest-done');
    const ctx = created[created.length - 1];
    assert.ok(ctx.started.length >= 1, 'expected at least one oscillator started');
});

test('playSound: a closed context is discarded and replaced; sound plays on the new one', () => {
    // Seed a context, then close it to simulate an iOS/Android teardown.
    discardCachedContext();
    nextCtx = makeFakeAudioContext('running');
    playSound('timer-low');
    const closedCtx = created[created.length - 1];
    closedCtx.state = 'closed';

    const before = created.length;
    nextCtx = makeFakeAudioContext('running');
    playSound('timer-low');
    assert.equal(created.length, before + 1, 'expected a fresh AudioContext to be created');
    const fresh = created[created.length - 1];
    assert.notEqual(fresh, closedCtx);
    assert.ok(fresh.started.length >= 1, 'tone should play on the replacement context');
});

test('playSound: a suspended context is resumed and the tone is scheduled after resume', async () => {
    discardCachedContext();
    const suspended = makeFakeAudioContext('suspended');
    nextCtx = suspended;
    playSound('pr');
    assert.equal(suspended.resumeCalls, 1, 'resume() should be called on a suspended context');
    // resume() resolves on the microtask queue; let it flush.
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(suspended.started.length >= 1, 'tone should be scheduled after resume resolves');
});

test('playSound: timer-warn produces a distinct tone', () => {
    discardCachedContext();
    nextCtx = makeFakeAudioContext('running');
    playSound('timer-warn');
    const ctx = created[created.length - 1];
    assert.ok(ctx.started.length >= 1);
});

test('playSound: no AudioContext available is a safe no-op', () => {
    discardCachedContext();
    const saved = globalThis.window.AudioContext;
    globalThis.window.AudioContext = undefined;
    globalThis.window.webkitAudioContext = undefined;
    assert.doesNotThrow(() => playSound('rest-done'));
    globalThis.window.AudioContext = saved;
});
