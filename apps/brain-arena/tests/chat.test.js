'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    MAX_LEN,
    RATE_LIMIT_MS,
    MODERATION_TIMEOUT_MS,
    setModerationEndpoint,
    getModerationEndpoint,
    sanitizeText,
    checkProfanity,
    shouldRateLimit,
    formatTimestamp
} = require('../js/chat.js');

// --- sanitizeText ----------------------------------------------------

test('sanitizeText: trims surrounding whitespace', () => {
    assert.equal(sanitizeText('  hello  '), 'hello');
});

test('sanitizeText: collapses runs of whitespace', () => {
    assert.equal(sanitizeText('hello\n\t  world'), 'hello world');
});

test('sanitizeText: empty / all-whitespace returns ""', () => {
    assert.equal(sanitizeText(''), '');
    assert.equal(sanitizeText('   '), '');
    assert.equal(sanitizeText('\n\n'), '');
});

test('sanitizeText: rejects non-strings', () => {
    assert.equal(sanitizeText(null), '');
    assert.equal(sanitizeText(undefined), '');
    assert.equal(sanitizeText(42), '');
});

test('sanitizeText: caps length at MAX_LEN', () => {
    const long = 'a'.repeat(MAX_LEN + 50);
    const out = sanitizeText(long);
    assert.equal(out.length, MAX_LEN);
});

// --- moderation endpoint plumbing ------------------------------------

test('setModerationEndpoint / getModerationEndpoint round-trip', () => {
    const original = getModerationEndpoint();
    setModerationEndpoint('https://example.test/moderation');
    assert.equal(getModerationEndpoint(), 'https://example.test/moderation');
    // Bad input is ignored, prior value preserved
    setModerationEndpoint('');
    setModerationEndpoint(null);
    assert.equal(getModerationEndpoint(), 'https://example.test/moderation');
    setModerationEndpoint(original);
});

test('setModerationEndpoint default is a real URL', () => {
    assert.match(getModerationEndpoint(), /^https?:\/\//);
});

// --- checkProfanity (with stubbed fetch) -----------------------------

function withFetchStub(impl, fn) {
    const original = global.fetch;
    global.fetch = impl;
    return Promise.resolve().then(fn).finally(() => {
        global.fetch = original;
    });
}

test('checkProfanity: empty input short-circuits to clean', async () => {
    const r = await checkProfanity('');
    assert.deepEqual(r, { ok: true, blocked: false });
});

test('checkProfanity: API returns "true" -> blocked', async () => {
    await withFetchStub(
        async () => ({ ok: true, text: async () => 'true' }),
        async () => {
            const r = await checkProfanity('anything');
            assert.deepEqual(r, { ok: true, blocked: true });
        }
    );
});

test('checkProfanity: API returns "false" -> clean', async () => {
    await withFetchStub(
        async () => ({ ok: true, text: async () => 'false' }),
        async () => {
            const r = await checkProfanity('hello world');
            assert.deepEqual(r, { ok: true, blocked: false });
        }
    );
});

test('checkProfanity: API non-2xx -> fail-open with http-N error', async () => {
    await withFetchStub(
        async () => ({ ok: false, status: 503, text: async () => '' }),
        async () => {
            const r = await checkProfanity('hello');
            assert.equal(r.ok, false);
            assert.equal(r.error, 'http-503');
        }
    );
});

test('checkProfanity: fetch throws -> fail-open with network error', async () => {
    await withFetchStub(
        async () => { throw new Error('boom'); },
        async () => {
            const r = await checkProfanity('hello');
            assert.deepEqual(r, { ok: false, error: 'network' });
        }
    );
});

test('checkProfanity: missing fetch (no DOM) returns fetch-unavailable', async () => {
    const original = global.fetch;
    delete global.fetch;
    try {
        const r = await checkProfanity('hello');
        assert.equal(r.ok, false);
        assert.equal(r.error, 'fetch-unavailable');
    } finally {
        global.fetch = original;
    }
});

// --- shouldRateLimit -------------------------------------------------

test('shouldRateLimit: never limit on first send', () => {
    assert.equal(shouldRateLimit(null, Date.now()), false);
});

test('shouldRateLimit: limits within RATE_LIMIT_MS', () => {
    const now = Date.now();
    assert.equal(shouldRateLimit(now - 500, now), true);
});

test('shouldRateLimit: allows after RATE_LIMIT_MS', () => {
    const now = Date.now();
    assert.equal(shouldRateLimit(now - RATE_LIMIT_MS - 100, now), false);
});

// --- formatTimestamp -------------------------------------------------

test('formatTimestamp: returns HH:MM for a real timestamp', () => {
    const out = formatTimestamp(Date.UTC(2026, 4, 19, 12, 30));
    assert.match(out, /^\d{2}:\d{2}$/);
});

test('formatTimestamp: empty string for invalid input', () => {
    assert.equal(formatTimestamp(NaN), '');
});

// --- exported constants ---------------------------------------------

test('constants exported for callers', () => {
    assert.equal(typeof MAX_LEN, 'number');
    assert.equal(typeof RATE_LIMIT_MS, 'number');
    assert.equal(typeof MODERATION_TIMEOUT_MS, 'number');
});
