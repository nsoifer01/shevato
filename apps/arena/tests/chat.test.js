'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    MAX_LEN,
    RATE_LIMIT_MS,
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

// --- checkProfanity (local wordlist) ---------------------------------
//
// The check runs entirely in-process against a curated wordlist; no
// network. Whole-word (\b-anchored) matching is what keeps ordinary
// words that merely contain a flagged substring from being flagged.

test('checkProfanity: empty input short-circuits to clean', () => {
    assert.deepEqual(checkProfanity(''), { ok: true, blocked: false });
});

test('checkProfanity: clean sentence is not blocked', () => {
    assert.deepEqual(checkProfanity('good game everyone, nice round'), { ok: true, blocked: false });
});

test('checkProfanity: an actual profanity is caught', () => {
    assert.deepEqual(checkProfanity('you are a shit player'), { ok: true, blocked: true });
    assert.equal(checkProfanity('fuck this').blocked, true);
});

test('checkProfanity: caught regardless of case', () => {
    assert.equal(checkProfanity('SHIT').blocked, true);
    assert.equal(checkProfanity('WhAt An AsShOlE').blocked, true);
});

test('checkProfanity: caught next to punctuation', () => {
    assert.equal(checkProfanity('well, fuck!').blocked, true);
    assert.equal(checkProfanity('(bitch)').blocked, true);
});

// Scunthorpe problem: clean words containing a flagged substring must pass.
test('checkProfanity: substring-only matches are NOT flagged', () => {
    for (const clean of ['class', 'assess', 'assassin', 'cockpit', 'cocktail',
                         'bass', 'grass', 'pass the ball', 'Scunthorpe',
                         'analysis', 'dickinson', 'shitake']) {
        assert.equal(checkProfanity(clean).blocked, false, `"${clean}" should be clean`);
    }
});

test('checkProfanity: never leaves the browser (no fetch involved)', () => {
    const original = global.fetch;
    global.fetch = () => { throw new Error('network must not be touched'); };
    try {
        assert.equal(checkProfanity('fuck').blocked, true);
        assert.equal(checkProfanity('hello').blocked, false);
    } finally {
        global.fetch = original;
    }
});

test('checkProfanity: fail-open if the matcher throws', () => {
    // A non-string sneaking past sanitizeText must not block chat.
    const r = checkProfanity({ toString() { throw new Error('boom'); } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'filter-error');
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
});
