// Regression guard: enforce that no HTML page loads the v9 compat
// Firebase SDK alongside the v10 modular SDK.
//
// Loading both SDKs creates two separate `<authDomain>/__/auth/iframe`
// frames; each iframe loads `apis.google.com/js/api.js?onload=__iframefcb<id>`
// and registers a callback on `window`. On mobile the two iframes
// race over those callback slots and gapi.js throws
// `Uncaught TypeError: u[v] is not a function`. firebase-config.js is
// the single source of auth state - it exposes `window.firebaseAuth`
// for non-module callers. This test fails if anyone re-introduces a
// compat script tag on any page.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FORBIDDEN_PATTERNS = [
    /firebase-app-compat\.js/i,
    /firebase-auth-compat\.js/i,
    /firebasejs\/9\.\d+\.\d+\/firebase-(app|auth|firestore|database)-compat/i
];

// Generated page trees (gitignored build output, ~35k files). Walking them
// cost ~3s per test run and told us nothing new: every one of those pages is
// stamped from a committed generator template, so the guard scans the
// GENERATOR SOURCES below instead, plus a small canary sample of the actual
// output when it exists on disk.
const GENERATED_DIRS = [
    'apps/gym-tracker/exercises',   // scripts/build-exercise-pages.cjs output
    'apps/rising-shows/shows',      // scripts/render-show-page.js output
];
// The committed code that stamps those pages (whole directories, so a new or
// renamed generator stays covered).
const GENERATOR_SOURCE_DIRS = [
    'apps/gym-tracker/scripts',
    'apps/rising-shows/scripts',
];

const skipDirs = new Set(GENERATED_DIRS.map((d) => join(REPO_ROOT, d)));

function collectFiles(dir, ext, acc = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            if (skipDirs.has(full)) continue;
            collectFiles(full, ext, acc);
        } else if (ext.some((e) => entry.endsWith(e))) {
            acc.push(full);
        }
    }
    return acc;
}

/**
 * Up to `limit` HTML files from a generated tree, as an is-the-output-sane
 * canary. Walks lazily and STOPS at the limit: these trees hold tens of
 * thousands of entries and enumerating them all is what made this test file
 * cost seconds per run.
 */
function sampleGenerated(dir, limit = 3) {
    const root = join(REPO_ROOT, dir);
    if (!existsSync(root)) return []; // fresh clone: output not built, sources still scanned
    const found = [];
    const queue = [root];
    while (queue.length > 0 && found.length < limit) {
        const current = queue.shift();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            if (found.length >= limit) break;
            const full = join(current, entry.name);
            if (entry.isDirectory()) queue.push(full);
            else if (entry.name.endsWith('.html')) found.push(full);
        }
    }
    return found;
}

function findOffenders(files) {
    const offenders = [];
    for (const file of files) {
        const content = readFileSync(file, 'utf8');
        // Strip HTML comments so historical context inside <!-- ... -->
        // doesn't trip the guard. We only care about live <script> tags.
        const stripped = content.replace(/<!--[\s\S]*?-->/g, '');
        for (const pattern of FORBIDDEN_PATTERNS) {
            if (pattern.test(stripped)) {
                offenders.push(`${relative(REPO_ROOT, file)} matches ${pattern}`);
            }
        }
    }
    return offenders;
}

test('no HTML file loads the Firebase v9 compat SDK', () => {
    const htmlFiles = collectFiles(REPO_ROOT, ['.html']);
    assert.ok(htmlFiles.length > 0, 'expected to find HTML files in the repo');
    assert.ok(
        !htmlFiles.some((f) => f.includes(`${sep}exercises${sep}`) && f.includes('gym-tracker')),
        'sanity: the generated exercise tree is excluded from the walk'
    );
    assert.deepEqual(
        findOffenders(htmlFiles),
        [],
        'Found compat-SDK references - they cause the mobile __iframefcb race'
    );
});

test('no page GENERATOR emits the Firebase v9 compat SDK', () => {
    // The generated trees are excluded from the walk above; their committed
    // generators (templates included) carry the guard instead.
    const sources = GENERATOR_SOURCE_DIRS.flatMap((d) =>
        collectFiles(join(REPO_ROOT, d), ['.js', '.cjs', '.mjs']));
    assert.ok(sources.length > 0, 'expected generator sources to scan');
    assert.deepEqual(findOffenders(sources), [],
        'a generator template referencing the compat SDK would stamp it into thousands of pages');
});

test('generated-output canary: sampled built pages are compat-free', () => {
    const samples = GENERATED_DIRS.flatMap((d) => sampleGenerated(d));
    // Zero samples is fine (fresh clone / worktree without build output).
    assert.deepEqual(findOffenders(samples), []);
});

test('firebase-config.js declares the window.firebaseAuth adapter', () => {
    const config = readFileSync(join(REPO_ROOT, 'firebase-config.js'), 'utf8');
    assert.match(config, /window\.firebaseAuth\s*=/, 'firebase-config.js must expose window.firebaseAuth');
    assert.match(config, /firebaseAuthReady/, 'firebase-config.js must dispatch the firebaseAuthReady event');
    assert.match(config, /onAuthStateChanged/, 'firebase-config.js must wire the modular onAuthStateChanged');
});
