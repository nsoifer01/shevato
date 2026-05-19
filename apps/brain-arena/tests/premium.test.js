'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const {
    toMillis,
    isPaidPremium,
    trialRemainingMs,
    trialDaysLeft,
    isInTrial,
    isPremium,
    premiumStatusText,
    isAdmin
} = require('../js/premium.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 4, 19, 12, 0, 0);

// --- toMillis ----------------------------------------------------------

test('toMillis: null / undefined -> null', () => {
    assert.equal(toMillis(null), null);
    assert.equal(toMillis(undefined), null);
});

test('toMillis: numeric passthrough', () => {
    assert.equal(toMillis(1234567890), 1234567890);
});

test('toMillis: Firestore Timestamp via toMillis()', () => {
    const stamp = { toMillis: () => NOW };
    assert.equal(toMillis(stamp), NOW);
});

test('toMillis: Firestore Timestamp via seconds field', () => {
    const stamp = { seconds: 1000, nanoseconds: 0 };
    assert.equal(toMillis(stamp), 1_000_000);
});

// --- isPaidPremium -----------------------------------------------------

test('isPaidPremium: only true for explicit boolean true', () => {
    assert.equal(isPaidPremium(null), false);
    assert.equal(isPaidPremium({}), false);
    assert.equal(isPaidPremium({ premium: false }), false);
    assert.equal(isPaidPremium({ premium: 1 }), false);
    assert.equal(isPaidPremium({ premium: 'yes' }), false);
    assert.equal(isPaidPremium({ premium: true }), true);
});

// --- trial math --------------------------------------------------------

test('trialRemainingMs: zero for null profile / missing signedUpAt', () => {
    assert.equal(trialRemainingMs(null, NOW), 0);
    assert.equal(trialRemainingMs({}, NOW), 0);
    assert.equal(trialRemainingMs({ signedUpAt: null }, NOW), 0);
});

test('trialRemainingMs: full window just after sign-up', () => {
    const profile = { signedUpAt: NOW };
    assert.equal(trialRemainingMs(profile, NOW), Config.TRIAL_DURATION_MS);
});

test('trialRemainingMs: counts down with time', () => {
    const profile = { signedUpAt: NOW - 10 * DAY_MS };
    assert.equal(trialRemainingMs(profile, NOW), Config.TRIAL_DURATION_MS - 10 * DAY_MS);
});

test('trialRemainingMs: clamps to zero after expiry', () => {
    const profile = { signedUpAt: NOW - 60 * DAY_MS };
    assert.equal(trialRemainingMs(profile, NOW), 0);
});

test('trialDaysLeft: rounds up so a partial day still counts', () => {
    const profile = { signedUpAt: NOW - 29 * DAY_MS - 1000 * 60 * 60 };
    // ~23 hours into day 30 -> 1 day remaining when ceiled
    assert.equal(trialDaysLeft(profile, NOW), 1);
});

test('trialDaysLeft: 30 right at sign-up', () => {
    assert.equal(trialDaysLeft({ signedUpAt: NOW }, NOW), 30);
});

test('isInTrial: true inside window, false after', () => {
    assert.equal(isInTrial({ signedUpAt: NOW - 5 * DAY_MS }, NOW), true);
    assert.equal(isInTrial({ signedUpAt: NOW - 31 * DAY_MS }, NOW), false);
});

// --- isPremium ---------------------------------------------------------

test('isPremium: paid wins regardless of trial state', () => {
    const profile = { premium: true, signedUpAt: NOW - 365 * DAY_MS };
    assert.equal(isPremium(profile, NOW), true);
});

test('isPremium: trial-only user is premium during window', () => {
    const profile = { premium: false, signedUpAt: NOW - 5 * DAY_MS };
    assert.equal(isPremium(profile, NOW), true);
});

test('isPremium: trial expired and unpaid -> false', () => {
    const profile = { premium: false, signedUpAt: NOW - 60 * DAY_MS };
    assert.equal(isPremium(profile, NOW), false);
});

test('isPremium: null profile -> false (signed-out state)', () => {
    assert.equal(isPremium(null, NOW), false);
});

// --- premiumStatusText -------------------------------------------------

test('premiumStatusText: paid -> active message', () => {
    const txt = premiumStatusText({ premium: true }, NOW);
    assert.match(txt, /Premium active/);
});

test('premiumStatusText: trial -> days-left message', () => {
    const profile = { premium: false, signedUpAt: NOW - 10 * DAY_MS };
    const txt = premiumStatusText(profile, NOW);
    assert.match(txt, /Free trial/);
    assert.match(txt, /20 days left/);
    assert.match(txt, new RegExp(Config.PREMIUM_PRICE_DISPLAY.replace(/\$/g, '\\$')));
});

test('premiumStatusText: expired -> upgrade prompt with price', () => {
    const profile = { premium: false, signedUpAt: NOW - 60 * DAY_MS };
    const txt = premiumStatusText(profile, NOW);
    assert.match(txt, /Upgrade/);
    assert.match(txt, new RegExp(Config.PREMIUM_PRICE_DISPLAY.replace(/\$/g, '\\$')));
});

// --- isAdmin -----------------------------------------------------------

test('isAdmin: empty list -> always false', () => {
    assert.equal(isAdmin('any-uid'), false);
    assert.equal(isAdmin(null), false);
});

test('isAdmin: matches uid in config list', () => {
    const original = Config.ADMIN_UIDS.slice();
    Config.ADMIN_UIDS.length = 0;
    Config.ADMIN_UIDS.push('admin-uid-1', 'admin-uid-2');
    try {
        assert.equal(isAdmin('admin-uid-1'), true);
        assert.equal(isAdmin('admin-uid-2'), true);
        assert.equal(isAdmin('someone-else'), false);
        assert.equal(isAdmin(''), false);
    } finally {
        Config.ADMIN_UIDS.length = 0;
        original.forEach((u) => Config.ADMIN_UIDS.push(u));
    }
});
