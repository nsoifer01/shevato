// Service-worker precache completeness for Trip Planner (static text checks).
//
// This file exists because of a shipped, user-visible failure: index.html
// requested `css/styles.css?v=67` while sw.js precached `?v=66`. The query
// string is part of the Cache API key, so the two are DIFFERENT entries; a
// first online visit followed by a cold offline reload asked for v=67, found
// nothing, and rendered a white unstyled page with menus that should have
// been hidden. Nine passing PWA browser checks did not see it, because they
// never asserted that the cached URL is the URL the document asks for.
//
// Three directions are asserted here:
//   1. Every versioned asset index.html links is precached at that EXACT
//      version string (the drift above).
//   2. Every precached app-local URL exists on disk. ESSENTIAL_URLS installs
//      with addAll, which is atomic, so one missing file blocks the whole
//      install and users keep the previous version forever.
//   3. The essential list actually contains the shell an offline load cannot
//      render without.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');
const swSrc = readFileSync(join(APP_ROOT, 'sw.js'), 'utf8');
const indexHtml = readFileSync(join(APP_ROOT, 'index.html'), 'utf8');

// Both lists are plain literals of quoted strings; parse them as JSON after
// normalizing quotes and stripping comment lines, so no sw.js code executes.
function parseList(name) {
    const m = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n\\]);`).exec(swSrc);
    assert.ok(m, `${name} literal found in sw.js`);
    const body = m[1]
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
    return JSON.parse(body.replace(/'/g, '"').replace(/,(\s*\])/, '$1'));
}

const ESSENTIAL_URLS = parseList('ESSENTIAL_URLS');
const OPTIONAL_URLS = parseList('OPTIONAL_URLS');
const PRECACHE_URLS = [...ESSENTIAL_URLS, ...OPTIONAL_URLS];
const precached = new Set(PRECACHE_URLS);

// './css/styles.css?v=68' and '../../assets/css/main.css' both resolve against
// /apps/trip-planner/; comparing resolved paths is what the Cache API does.
function resolveUrl(u) {
    return new URL(u, 'https://shevato.com/apps/trip-planner/').pathname
        + new URL(u, 'https://shevato.com/apps/trip-planner/').search;
}
const precachedResolved = new Set(PRECACHE_URLS.map(resolveUrl));

// Where a precached URL lives on disk, or null when it is not a real file
// (the './' navigation entry).
function diskPathFor(u) {
    if (u === './') return join(APP_ROOT, 'index.html');
    const { pathname } = new URL(u, 'https://shevato.com/apps/trip-planner/');
    return join(REPO_ROOT, pathname.replace(/^\//, ''));
}

test('every versioned asset index.html links is precached at that exact version', () => {
    // The v=67 vs v=66 bug, pinned. Matching on the full `name?v=N` string is
    // the whole point: a version-insensitive check passes on the broken pair.
    const versioned = [...indexHtml.matchAll(/(?:href|src)="((?:css|js)\/[^"]+\?v=\d+)"/g)]
        .map(m => `./${m[1]}`);
    assert.ok(versioned.length >= 3,
        `index.html links versioned app assets (found ${versioned.length})`);
    const missing = versioned.filter(u => !precached.has(u));
    assert.deepEqual(missing, [],
        `index.html asks for URLs the worker does not cache, so they 404 offline: ${missing.join(', ')}`);
});

test('every local asset index.html references is precached (resolved URL match)', () => {
    // Both spellings of the same file appear in index.html ('/assets/js/...'
    // and '../../assets/js/...'), so compare resolved paths, not strings.
    const refs = [...indexHtml.matchAll(/(?:href|src)="([^"]+)"/g)]
        .map(m => m[1])
        .filter(u => !/^https?:|^#|^mailto:|^data:/.test(u))
        .filter(u => !/^\/privacy/.test(u));   // a page link, not a shell asset
    const missing = [...new Set(refs.map(resolveUrl))].filter(u => !precachedResolved.has(u));
    assert.deepEqual(missing, [],
        `shell assets missing from the precache (they fail on a cold offline load): ${missing.join(', ')}`);
});

test('every precached URL exists on disk (addAll is atomic for the essentials)', () => {
    const missing = PRECACHE_URLS.filter(u => !existsSync(diskPathFor(u)));
    assert.deepEqual(missing, [],
        `precache entries with no file behind them: ${missing.join(', ')}`);
});

test('the essential list holds the shell an offline load cannot render without', () => {
    for (const u of ['./', './index.html', '../../assets/css/main.css']) {
        assert.ok(ESSENTIAL_URLS.includes(u), `${u} is essential`);
    }
    // The three versioned app files, whatever version they are currently on.
    for (const prefix of ['./css/styles.css?v=', './js/trip-logic.js?v=', './js/app.js?v=']) {
        assert.ok(ESSENTIAL_URLS.some(u => u.startsWith(prefix)),
            `${prefix}N is essential`);
    }
});

test('the essentials install atomically and the optionals do not block them', () => {
    assert.match(swSrc, /await cache\.addAll\(ESSENTIAL_URLS\)/,
        'ESSENTIAL_URLS must install with addAll so a 404 rejects the install');
    assert.match(swSrc, /OPTIONAL_URLS\.map\(\(u\) => cache\.add\(u\)\.catch/,
        'OPTIONAL_URLS stays best-effort');
    assert.ok(!/PRECACHE_URLS\.map\(\(u\) => cache\.add\(u\)\.catch/.test(swSrc),
        'the old swallow-everything install must be gone');
});

test('network-first reads have a bounded fallback to the cache', () => {
    // Without a deadline, a hung-but-not-refused connection holds the page
    // for the browser's own multi-minute timeout while a good precached copy
    // sits on disk.
    assert.match(swSrc, /NETWORK_FIRST_TIMEOUT_MS\s*=\s*(\d+)/);
    const ms = Number(/NETWORK_FIRST_TIMEOUT_MS\s*=\s*(\d+)/.exec(swSrc)[1]);
    assert.ok(ms > 0 && ms <= 15000, `deadline is bounded and sane (got ${ms}ms)`);
    assert.match(swSrc, /fetchWithDeadline\(req, NETWORK_FIRST_TIMEOUT_MS\)/);
});

test('CACHE_VERSION is strict semver and names both caches', () => {
    const m = /const CACHE_VERSION = '([^']+)'/.exec(swSrc);
    assert.ok(m, 'CACHE_VERSION found');
    assert.match(m[1], /^\d+\.\d+\.\d+$/, 'MAJOR.MINOR.PATCH');
    assert.ok(swSrc.includes('`trip-precache-${CACHE_VERSION}`'));
    assert.ok(swSrc.includes('`trip-runtime-${CACHE_VERSION}`'));
});
