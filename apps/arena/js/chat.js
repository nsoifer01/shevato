/*
 * Brain Arena - chat client helpers.
 *
 * Pure utilities (sanitization, rate-limit, timestamp formatting) live
 * here alongside the profanity check. Moderation is done entirely
 * locally against a small curated wordlist: nothing about a chat
 * message ever leaves the browser. (This replaced a remote lookup that
 * put the full message text in a third party's query string / access
 * logs.) This is best-effort politeness filtering for a friends' party
 * game, not adversarial moderation.
 *
 * Matching is whole-word (word-boundary anchored), so ordinary words
 * that merely contain a flagged substring pass cleanly (the classic
 * "Scunthorpe problem": "class", "assess", "cockpit" are all fine).
 *
 * Failure mode: if the check throws for any reason, the message passes
 * through (fail-open). Rationale - chat is non-critical social glue; a
 * filter bug must never be able to block the chat surface.
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

    // Curated profanity list. Kept short on purpose: a huge list in a
    // game full of place names and player handles generates more false
    // positives than it prevents. Add words (and their common inflected
    // forms) here as needed; each entry is matched as a whole word.
    const PROFANITY = [
        'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'fuckin',
        'motherfucker', 'motherfuckers', 'motherfucking',
        'shit', 'shits', 'shitty', 'shithead', 'bullshit',
        'ass', 'asses', 'asshole', 'assholes', 'jackass',
        'bitch', 'bitches', 'bitching',
        'bastard', 'bastards',
        'dick', 'dicks', 'dickhead', 'dickheads',
        'cock', 'cocks', 'cocksucker',
        'pussy', 'pussies',
        'cunt', 'cunts',
        'slut', 'sluts',
        'whore', 'whores',
        'douche', 'douchebag',
        'wanker', 'wankers',
        'twat', 'twats',
        'prick', 'pricks',
        'bollocks',
        'nigger', 'niggers', 'nigga', 'niggas',
        'faggot', 'faggots', 'fag', 'fags',
        'retard', 'retards', 'retarded'
    ];

    // \b...\b anchors each match to word boundaries, so a flagged word
    // is only caught as a standalone token. "class" / "assess" contain
    // "ass" but never as a bounded word, so they pass.
    const PROFANITY_RE = new RegExp('\\b(' + PROFANITY.join('|') + ')\\b', 'i');

    function sanitizeText(raw) {
        if (typeof raw !== 'string') return '';
        const trimmed = raw.replace(/\s+/g, ' ').trim();
        if (!trimmed) return '';
        return trimmed.length > MAX_LEN ? trimmed.slice(0, MAX_LEN) : trimmed;
    }

    /**
     * Check whether `text` contains a listed profane word, locally.
     * Nothing leaves the browser. Returns one of:
     *   { ok: true,  blocked: false }        — clean
     *   { ok: true,  blocked: true  }        — a flagged word matched
     *   { ok: false, error: 'filter-error' } — the check itself threw
     * Synchronous, but the bundled app.js `await`s it, which is fine.
     * Callers can decide whether to treat ok=false as block or allow;
     * app.js treats it as allow so a filter bug can't paralyse chat.
     */
    function checkProfanity(text) {
        if (!text) return { ok: true, blocked: false };
        try {
            return { ok: true, blocked: PROFANITY_RE.test(text) };
        } catch (err) {
            return { ok: false, error: 'filter-error' };
        }
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
        sanitizeText,
        checkProfanity,
        shouldRateLimit,
        formatTimestamp
    };
}));
