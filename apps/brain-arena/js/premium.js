/*
 * Brain Arena — premium tier math.
 *
 * Pure helpers around the "is this user premium?" check. Two ways in:
 *   1. Paid one-time fee — webhook flips users/{uid}.triviaProfile.premium=true.
 *   2. 30-day free trial — counted from triviaProfile.signedUpAt.
 *
 * `signedUpAt` is written as a Firestore serverTimestamp, which surfaces in
 * the client as a Timestamp instance (.toMillis()). The pending-write case
 * leaves the field as null for a tick, so we treat null as "no trial yet"
 * (rare but harmless — the snapshot listener re-runs once the server stamp
 * lands).
 *
 * UMD: CommonJS for node:test + window.BrainArena.Premium for the browser.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        const Config = require('./config.js');
        module.exports = factory(Config);
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.Premium = factory(ns.Config);
    }
}(typeof self !== 'undefined' ? self : this, function (Config) {
    'use strict';

    const DAY_MS = 24 * 60 * 60 * 1000;

    function toMillis(val) {
        if (val == null) return null;
        if (typeof val === 'number') return val;
        if (typeof val === 'object') {
            if (typeof val.toMillis === 'function') return val.toMillis();
            if (typeof val.seconds === 'number') return val.seconds * 1000;
        }
        return null;
    }

    function isPaidPremium(profile) {
        return !!(profile && profile.premium === true);
    }

    function trialRemainingMs(profile, now) {
        if (!profile) return 0;
        const start = toMillis(profile.signedUpAt);
        if (start == null) return 0;
        const expiresAt = start + Config.TRIAL_DURATION_MS;
        const remaining = expiresAt - now;
        return remaining > 0 ? remaining : 0;
    }

    function isInTrial(profile, now) {
        return trialRemainingMs(profile, now) > 0;
    }

    function isPremium(profile, now) {
        return isPaidPremium(profile) || isInTrial(profile, now);
    }

    function trialDaysLeft(profile, now) {
        return Math.ceil(trialRemainingMs(profile, now) / DAY_MS);
    }

    function premiumStatusText(profile, now) {
        if (isPaidPremium(profile)) {
            return 'Premium active — private rooms, custom packs, and detailed stats are unlocked. Thanks for supporting Shevato!';
        }
        const days = trialDaysLeft(profile, now);
        if (days > 0) {
            const noun = days === 1 ? 'day' : 'days';
            return `Free trial — ${days} ${noun} left. After the trial, upgrade for ${Config.PREMIUM_PRICE_DISPLAY} to keep private rooms, custom packs, and detailed stats unlocked.`;
        }
        return `Upgrade for ${Config.PREMIUM_PRICE_DISPLAY} to unlock private rooms, custom question packs, and detailed post-game stats.`;
    }

    function isAdmin(uid) {
        if (!uid) return false;
        const admins = Array.isArray(Config.ADMIN_UIDS) ? Config.ADMIN_UIDS : [];
        return admins.indexOf(uid) !== -1;
    }

    return {
        toMillis,
        isPaidPremium,
        trialRemainingMs,
        trialDaysLeft,
        isInTrial,
        isPremium,
        premiumStatusText,
        isAdmin
    };
}));
