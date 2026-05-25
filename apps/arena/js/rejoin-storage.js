/*
 * Brain Arena — rejoin breadcrumb storage (Item #8).
 *
 * Pure helpers around the localStorage entry that powers the
 * "Rejoin ABCDE?" banner. Storage + clock are both injectable so the
 * helpers stay testable without touching browser globals.
 *
 *   saveRecentRoom(storage, now, code, uid)
 *   getRecentRoom(storage, now)        -> entry | null
 *   clearRecentRoom(storage)
 *
 * Entries older than REJOIN_TTL_MS, malformed entries, and entries
 * tagged with a different uid than the caller is responsible for —
 * those are filtered by the consumer (the maybeShowRejoinBanner gate).
 *
 * UMD: CommonJS for node:test + window.BrainArena.RejoinStorage.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.RejoinStorage = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const REJOIN_KEY = 'arenaRecentRoom';
    const REJOIN_TTL_MS = 2 * 60 * 60 * 1000;
    const CODE_RE = /^[A-Z0-9]+$/;

    function saveRecentRoom(storage, now, code, uid) {
        if (!storage || typeof storage.setItem !== 'function') return false;
        if (typeof code !== 'string' || !CODE_RE.test(code)) return false;
        if (!uid) return false;
        try {
            storage.setItem(REJOIN_KEY, JSON.stringify({
                code,
                uid: String(uid),
                savedAt: typeof now === 'number' ? now : Date.now()
            }));
            return true;
        } catch (_) {
            return false;
        }
    }

    function clearRecentRoom(storage) {
        if (!storage || typeof storage.removeItem !== 'function') return;
        try { storage.removeItem(REJOIN_KEY); } catch (_) { /* ignore */ }
    }

    function getRecentRoom(storage, now) {
        if (!storage || typeof storage.getItem !== 'function') return null;
        let raw;
        try { raw = storage.getItem(REJOIN_KEY); } catch (_) { return null; }
        if (!raw) return null;
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return null; }
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.code !== 'string' || !CODE_RE.test(parsed.code)) return null;
        const ts = Number(parsed.savedAt);
        if (!Number.isFinite(ts)) return null;
        const nowMs = typeof now === 'number' ? now : Date.now();
        const age = nowMs - ts;
        if (!Number.isFinite(age) || age < 0 || age > REJOIN_TTL_MS) return null;
        return {
            code: parsed.code,
            uid: parsed.uid == null ? null : String(parsed.uid),
            savedAt: ts
        };
    }

    return {
        REJOIN_KEY,
        REJOIN_TTL_MS,
        saveRecentRoom,
        clearRecentRoom,
        getRecentRoom
    };
}));
