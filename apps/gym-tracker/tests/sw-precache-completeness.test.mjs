// Service-worker precache completeness (static text checks, no vm).
//
// Two failure modes have to fail loudly at test time because they only bite
// users in the field:
//   1. New-module-not-cached: a new js/ module ships, PRECACHE_URLS is not
//      updated, and the app breaks OFFLINE ONLY (the module 404s from cache).
//      Nobody notices in development because the network is up.
//   2. Deleted-file-kills-install: cache.addAll() is atomic, so ONE listed URL
//      that 404s fails the whole install and existing users silently stay on
//      the previous version forever.
// Both directions are asserted here: disk -> list and list -> disk.
//
// css/exercise-page.css is intentionally NOT precached: it styles only the
// generated /exercises/ directory pages, which are not part of the offline
// app shell (index.html never links it).
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const swSrc = readFileSync(join(APP_ROOT, 'sw.js'), 'utf8');
const indexHtml = readFileSync(join(APP_ROOT, 'index.html'), 'utf8');

// The array is a plain literal of './...' strings; parse it as JSON after
// normalizing quotes so no sw.js code ever executes here.
const listMatch = /const PRECACHE_URLS = (\[[\s\S]*?\]);/.exec(swSrc);
assert.ok(listMatch, 'PRECACHE_URLS literal found in sw.js');
const PRECACHE_URLS = JSON.parse(
    listMatch[1].replace(/'/g, '"').replace(/,\s*\]/, ']')
);
const precached = new Set(PRECACHE_URLS);

function walk(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, acc);
        else acc.push(full);
    }
    return acc;
}

test('every js/ module on disk is precached', () => {
    const missing = walk(join(APP_ROOT, 'js'))
        .filter(f => f.endsWith('.js'))
        .map(f => './' + f.slice(APP_ROOT.length + 1).replaceAll('\\', '/'))
        .filter(u => !precached.has(u));
    assert.deepEqual(missing, [],
        `js modules missing from PRECACHE_URLS (they will 404 offline): ${missing.join(', ')}`);
});

test('every stylesheet the app shell links locally is precached', () => {
    // Only hrefs under this app's own css/ count; cross-app and site-level
    // sheets (../mario-kart, /assets) belong to their own workers/pages.
    const localCss = [...indexHtml.matchAll(/<link[^>]+href="(css\/[^"]+)"/g)].map(m => `./${m[1]}`);
    assert.ok(localCss.length >= 2, 'index.html links app-local stylesheets');
    const missing = localCss.filter(u => !precached.has(u));
    assert.deepEqual(missing, [], `app css missing from PRECACHE_URLS: ${missing.join(', ')}`);
});

test('the exercise database (both forms) is precached', () => {
    // app.js imports data/exercises-db.js; the JSON twin is fetched by the
    // loader. Offline workouts need both.
    assert.ok(precached.has('./data/exercises-db.js'));
    assert.ok(precached.has('./data/exercises-db.json'));
});

test('css/exercise-page.css stays out of the precache (directory pages only)', () => {
    assert.ok(!precached.has('./css/exercise-page.css'),
        'exercise-page.css is not part of the offline app shell by design');
    assert.ok(!indexHtml.includes('exercise-page.css'),
        'and index.html must not link it (if it starts to, precache it and drop this pin)');
});

test('every PRECACHE_URLS entry exists on disk (addAll is atomic)', () => {
    const missing = PRECACHE_URLS.filter(u => {
        const rel = u === './' ? 'index.html' : u.replace(/^\.\//, '');
        return !existsSync(join(APP_ROOT, rel));
    });
    assert.deepEqual(missing, [],
        `PRECACHE_URLS entries with no file behind them (ONE 404 fails the whole install): ${missing.join(', ')}`);
});

test('the app shell entries themselves are present', () => {
    for (const u of ['./', './index.html', './manifest.webmanifest']) {
        assert.ok(precached.has(u), `${u} precached`);
    }
});

test('CACHE_VERSION is strict semver and names both caches', () => {
    const m = /const CACHE_VERSION = '([^']+)'/.exec(swSrc);
    assert.ok(m, 'CACHE_VERSION found');
    assert.match(m[1], /^\d+\.\d+\.\d+$/, 'MAJOR.MINOR.PATCH');
    assert.ok(swSrc.includes('`gym-precache-${CACHE_VERSION}`'), 'precache name derives from the version');
    assert.ok(swSrc.includes('`gym-runtime-${CACHE_VERSION}`'), 'runtime name derives from the version');
});

test('activate cleanup is scoped to the gym- prefix (shared origin!)', () => {
    // Without the prefix test the activate handler deleted EVERY cache on
    // shevato.com, wiping the other apps' offline shells (it happened; see
    // apps/trip-planner/tests/sw-activate.test.mjs for the behavioral pin).
    assert.match(swSrc, /n\.startsWith\('gym-'\)/,
        'stale-cache filter must select only gym- caches before deleting');
});
