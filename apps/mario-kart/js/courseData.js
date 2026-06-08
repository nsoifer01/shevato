// Course/map data source abstraction for the Mario Kart tracker.
//
// WHY THIS EXISTS
// ----------------
// There is no reliable, always-up-to-date public API for Mario Kart course
// lists (the popular `mk8_node_api` only exposes drivers/karts/tires/gliders,
// and Nintendo ships no official endpoint). So course data is *vendored* as a
// static JSON file and read through this thin abstraction. The abstraction is
// config-driven: today it loads a bundled JSON file; swapping to a remote URL
// (e.g. a community dataset you host, or output of scripts/sync-courses.mjs)
// is a one-line change in CourseDataConfig below. Nothing else in the app
// needs to know where the data came from.
//
// Classic-script module (no ES modules): pure transforms + a browser loader
// are attached to `window.CourseData` so main.js and the picker can use them,
// and so the pure transforms are unit-testable in the vm test harness.

(function () {
    'use strict';

    // ---- Configurable data sources. Swap `active` to change provider. --------
    const CourseDataConfig = {
        active: 'static',
        sources: {
            // Bundled JSON shipped with the app (default; always works offline).
            static: { type: 'json', url: 'data/courses.json' }
            // Future: point at a synced/remote dataset without touching any UI:
            // remote: { type: 'json', url: 'https://data.shevato.com/mario-kart/courses.json' }
        }
    };

    // ---- Pure transforms (no DOM, no network; safe to unit test) -------------

    // Validate the raw dataset shape and return its `games` map. Throws on a
    // structurally invalid file so problems surface loudly during sync/tests.
    function normalizeDataset(raw) {
        if (!raw || typeof raw !== 'object') throw new Error('courses dataset: not an object');
        if (!raw.games || typeof raw.games !== 'object') throw new Error('courses dataset: missing games');
        Object.keys(raw.games).forEach((gameKey) => {
            const game = raw.games[gameKey];
            if (!Array.isArray(game.cups)) throw new Error('courses dataset: ' + gameKey + ' missing cups[]');
            game.cups.forEach((cup) => {
                if (!cup || !cup.id || !cup.name || !Array.isArray(cup.courses)) {
                    throw new Error('courses dataset: ' + gameKey + ' has a malformed cup');
                }
                cup.courses.forEach((c) => {
                    if (!c || !c.id || !c.name) {
                        throw new Error('courses dataset: ' + gameKey + '/' + cup.id + ' has a malformed course');
                    }
                });
            });
        });
        return raw.games;
    }

    // Flatten a game node into a unique, cup-annotated course list. Courses that
    // appear in more than one cup (e.g. Crown City / Peach Stadium in MK World)
    // collapse to a single entry whose `cups` lists every cup it shows up in.
    function flattenCourses(gameNode) {
        const byId = new Map();
        (gameNode.cups || []).forEach((cup) => {
            (cup.courses || []).forEach((course) => {
                const existing = byId.get(course.id);
                if (existing) {
                    if (existing.cups.indexOf(cup.name) === -1) existing.cups.push(cup.name);
                    return;
                }
                byId.set(course.id, {
                    id: course.id,
                    name: course.name,
                    origin: course.origin || 'new',
                    aliases: Array.isArray(course.aliases) ? course.aliases.slice() : [],
                    cups: [cup.name]
                });
            });
        });
        return Array.from(byId.values());
    }

    // Group a game node into [{ cup, courses }] preserving file order.
    function groupByCup(gameNode) {
        return (gameNode.cups || []).map((cup) => ({
            id: cup.id,
            name: cup.name,
            courses: cup.courses.slice()
        }));
    }

    // ---- Ranked search -------------------------------------------------------
    // Punctuation-insensitive scoring so "mario bros circuit" matches
    // "Mario Bros. Circuit", "rr" hits Rainbow Road via alias, and "mks"
    // hits Mario Kart Stadium via word-initials. Higher score = better match.

    function norm(s) { return String(s == null ? '' : s).toLowerCase(); }
    function compact(s) { return norm(s).replace(/[^a-z0-9]+/g, ''); }
    function wordsOf(s) { return norm(s).split(/[^a-z0-9]+/).filter(Boolean); }
    function initialsOf(s) { return wordsOf(s).map((w) => w[0]).join(''); }

    function scoreCourse(course, query) {
        const qn = norm(query).trim();
        const qc = compact(query);
        if (!qn || !qc) return 1; // no query: everything matches equally

        const cName = compact(course.name);
        let score = 0;
        const bump = (v) => { if (v > score) score = v; };

        if (norm(course.name) === qn) bump(100);
        if (cName.startsWith(qc)) bump(86);
        if (wordsOf(course.name).some((w) => w.startsWith(qn))) bump(72);
        if (qc.length >= 2 && initialsOf(course.name).startsWith(qc)) bump(66);
        if (cName.indexOf(qc) !== -1) bump(50);

        (course.aliases || []).forEach((a) => {
            const ca = compact(a);
            if (ca === qc) bump(64);
            else if (ca.startsWith(qc)) bump(58);
            else if (ca.indexOf(qc) !== -1) bump(38);
        });

        if (norm(course.origin).indexOf(qn) !== -1) bump(22);
        if ((course.cups || []).some((cup) => norm(cup).indexOf(qn) !== -1)) bump(18);

        return score;
    }

    // Ranked, filtered list (best first). Empty query keeps original order.
    function rankCourses(courses, query) {
        if (!norm(query).trim()) return courses.slice();
        return courses
            .map((c, i) => ({ c: c, i: i, s: scoreCourse(c, query) }))
            .filter((r) => r.s > 0)
            .sort((a, b) => (b.s - a.s) || a.c.name.localeCompare(b.c.name) || (a.i - b.i))
            .map((r) => r.c);
    }

    // Back-compat name used by callers/tests; now ranked.
    function searchCourses(courses, query) { return rankCourses(courses, query); }

    function findCourse(courses, id) {
        return courses.find((c) => c.id === id) || null;
    }

    // ---- Per-game-version recents & favorites (localStorage) -----------------
    // Reuses the app's game-version-prefixed storage so MK8D and MK World keep
    // independent recent/favorite lists.

    function storageKey(base) {
        return (typeof window !== 'undefined' && window.getStorageKey)
            ? window.getStorageKey(base)
            : 'marioKart' + base;
    }

    function readList(base) {
        try {
            const raw = window.localStorage.getItem(storageKey(base));
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function writeList(base, list) {
        try {
            window.localStorage.setItem(storageKey(base), JSON.stringify(list));
        } catch (e) {
            /* storage full / unavailable: recents are best-effort */
        }
    }

    const RECENTS_KEY = 'RecentCourses';
    const FAVS_KEY = 'FavoriteCourses';
    const RECENTS_MAX = 6;

    function getRecentIds() { return readList(RECENTS_KEY); }

    function pushRecent(courseId) {
        if (!courseId) return;
        const next = [courseId].concat(getRecentIds().filter((id) => id !== courseId));
        writeList(RECENTS_KEY, next.slice(0, RECENTS_MAX));
    }

    function getFavoriteIds() { return readList(FAVS_KEY); }

    function isFavorite(courseId) { return getFavoriteIds().indexOf(courseId) !== -1; }

    function toggleFavorite(courseId) {
        if (!courseId) return false;
        const favs = getFavoriteIds();
        const idx = favs.indexOf(courseId);
        if (idx === -1) {
            favs.push(courseId);
            writeList(FAVS_KEY, favs);
            return true;
        }
        favs.splice(idx, 1);
        writeList(FAVS_KEY, favs);
        return false;
    }

    // ---- Browser loader (fetch + cache) --------------------------------------

    const cache = {}; // gameVersion -> { courses, cups, source }

    async function load(gameVersion) {
        const gv = gameVersion || (window.getCurrentGameVersion ? window.getCurrentGameVersion() : 'mk8d');
        if (cache[gv]) return cache[gv];

        const source = CourseDataConfig.sources[CourseDataConfig.active];
        const res = await fetch(source.url, { cache: 'no-cache' });
        if (!res.ok) throw new Error('CourseData: failed to load ' + source.url + ' (' + res.status + ')');
        const games = normalizeDataset(await res.json());
        const gameNode = games[gv];
        if (!gameNode) {
            cache[gv] = { courses: [], cups: [], source: null };
            return cache[gv];
        }
        cache[gv] = {
            courses: flattenCourses(gameNode),
            cups: groupByCup(gameNode),
            source: gameNode.source || null,
            label: gameNode.label || gv
        };
        return cache[gv];
    }

    // ---- Public surface ------------------------------------------------------
    window.CourseData = {
        config: CourseDataConfig,
        // pure transforms (unit-tested)
        normalizeDataset: normalizeDataset,
        flattenCourses: flattenCourses,
        groupByCup: groupByCup,
        searchCourses: searchCourses,
        rankCourses: rankCourses,
        scoreCourse: scoreCourse,
        findCourse: findCourse,
        // browser data access
        load: load,
        // recents & favorites
        getRecentIds: getRecentIds,
        pushRecent: pushRecent,
        getFavoriteIds: getFavoriteIds,
        isFavorite: isFavorite,
        toggleFavorite: toggleFavorite
    };
})();
