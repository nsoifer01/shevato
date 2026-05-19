/*
 * Brain Arena — chat client helpers.
 *
 * Pure utilities (sanitization, rate-limit, timestamp formatting) live
 * here alongside the moderation hook. Moderation is delegated to an
 * external API so this file never needs to enumerate the words it's
 * trying to keep out of chat — the API maintains the list, we just ask
 * "does this message contain profanity?" and trust the answer.
 *
 * Default backend is the free PurgoMalum service
 * (https://www.purgomalum.com). Override via `setModerationEndpoint`
 * if you want to point at your own moderation proxy (OpenAI moderation,
 * Cloudflare AI, Perspective API, etc.).
 *
 * Failure mode: if the API is unreachable, slow, or returns non-2xx,
 * messages pass through (fail-open). Rationale — chat is non-critical
 * social glue; blocking everyone on a third-party outage is worse UX
 * than the occasional escape. Errors are logged so you can spot drift.
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
    const MODERATION_TIMEOUT_MS = 2500;

    // Default endpoint — accepts ?text= and returns plain-text "true" or
    // "false". Swappable via setModerationEndpoint for self-hosted or
    // paid moderation backends.
    let moderationEndpoint = 'https://www.purgomalum.com/service/containsprofanity';

    function setModerationEndpoint(url) {
        if (typeof url === 'string' && url.length > 0) moderationEndpoint = url;
    }

    function getModerationEndpoint() {
        return moderationEndpoint;
    }

    function sanitizeText(raw) {
        if (typeof raw !== 'string') return '';
        const trimmed = raw.replace(/\s+/g, ' ').trim();
        if (!trimmed) return '';
        return trimmed.length > MAX_LEN ? trimmed.slice(0, MAX_LEN) : trimmed;
    }

    /**
     * Ask the external moderation API whether `text` contains anything
     * it considers profane. Returns a Promise that resolves to one of:
     *   { ok: true,  blocked: false }                       — clean
     *   { ok: true,  blocked: true  }                       — API said no
     *   { ok: false, error: 'timeout' | 'network' | string} — fail-open
     * Callers can decide whether to treat ok=false as block or allow;
     * the bundled app.js treats it as allow so a third-party outage
     * doesn't paralyse the chat surface.
     */
    async function checkProfanity(text) {
        if (!text) return { ok: true, blocked: false };
        if (typeof fetch !== 'function') {
            return { ok: false, error: 'fetch-unavailable' };
        }
        const url = `${moderationEndpoint}?text=${encodeURIComponent(text)}`;
        const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), MODERATION_TIMEOUT_MS) : null;
        try {
            const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
            if (timer) clearTimeout(timer);
            if (!res.ok) return { ok: false, error: `http-${res.status}` };
            const body = (await res.text()).trim().toLowerCase();
            return { ok: true, blocked: body === 'true' };
        } catch (err) {
            if (timer) clearTimeout(timer);
            const code = err && err.name === 'AbortError' ? 'timeout' : 'network';
            return { ok: false, error: code };
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
        MODERATION_TIMEOUT_MS,
        setModerationEndpoint,
        getModerationEndpoint,
        sanitizeText,
        checkProfanity,
        shouldRateLimit,
        formatTimestamp
    };
}));
