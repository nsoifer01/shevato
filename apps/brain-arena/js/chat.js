/*
 * Brain Arena — chat client helpers (pure).
 *
 * The Firestore wiring lives in app.js (subscribe / send / render);
 * this module owns the *pure* bits that are worth unit-testing:
 *
 *   - sanitizeText: collapses whitespace, trims, enforces 280 chars,
 *     refuses an all-whitespace message.
 *   - profanityCheck: a small in-tree blocklist + simple substring match.
 *     This is a courtesy filter, not a security boundary — but it stops
 *     the most obvious drive-by garbage without a network round-trip.
 *   - shouldRateLimit: returns true if the user is sending too fast.
 *     One message every 1.5 seconds is the default.
 *   - formatTimestamp: short HH:MM string for message rendering.
 *
 * UMD: CommonJS for node:test + window.BrainArena.Chat for the browser.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.Chat = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_LEN = 280;
    const RATE_LIMIT_MS = 1500;

    // Tiny blocklist — keeps the obvious slurs / explicit terms out.
    // Substring match is intentional: "fucking" matches "fuck", but we
    // also have to live with "Scunthorpe"-style false positives. Tune
    // by adding to this list, not by getting clever with regexes.
    // Lowercased; comparison is case-insensitive.
    const BLOCK_TERMS = [
        'fuck', 'shit', 'asshole', 'bitch', 'cunt', 'fag', 'retard',
        'nigger', 'nigga', 'chink', 'kike', 'spic', 'tranny'
    ];

    function sanitizeText(raw) {
        if (typeof raw !== 'string') return '';
        const trimmed = raw.replace(/\s+/g, ' ').trim();
        if (!trimmed) return '';
        return trimmed.length > MAX_LEN ? trimmed.slice(0, MAX_LEN) : trimmed;
    }

    function profanityCheck(text) {
        const t = String(text || '').toLowerCase();
        for (const term of BLOCK_TERMS) {
            if (t.indexOf(term) !== -1) return term;
        }
        return null;
    }

    /**
     * @param {number|null} lastSentAtMs — when the user last sent, or null
     * @param {number} nowMs
     * @returns {boolean}
     */
    function shouldRateLimit(lastSentAtMs, nowMs) {
        if (lastSentAtMs == null) return false;
        return (nowMs - lastSentAtMs) < RATE_LIMIT_MS;
    }

    function formatTimestamp(ms) {
        const d = new Date(ms);
        if (isNaN(d.getTime())) return '';
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }

    return {
        MAX_LEN,
        RATE_LIMIT_MS,
        BLOCK_TERMS,
        sanitizeText,
        profanityCheck,
        shouldRateLimit,
        formatTimestamp
    };
}));
