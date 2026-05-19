'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    MAX_LEN,
    RATE_LIMIT_MS,
    sanitizeText,
    profanityCheck,
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

// --- profanityCheck --------------------------------------------------

test('profanityCheck: clean text returns null', () => {
    assert.equal(profanityCheck('hello world'), null);
    assert.equal(profanityCheck(''), null);
});

test('profanityCheck: substring match catches in-word use', () => {
    const hit = profanityCheck('what the fuck dude');
    assert.equal(hit, 'fuck');
});

test('profanityCheck: case insensitive', () => {
    assert.equal(profanityCheck('SHIT'), 'shit');
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
