// Structural tests for firebase-config.js. This module is the single
// initialisation point for the whole project's Firebase usage, so we
// guard the invariants that "exactly once, single source of truth,
// cross-tab aware" depend on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = readFileSync(join(REPO_ROOT, 'firebase-config.js'), 'utf8');

test('firebase-config calls initializeApp exactly once', () => {
    const matches = CONFIG.match(/\binitializeApp\s*\(/g) || [];
    assert.equal(matches.length, 1, 'expected exactly one initializeApp() call');
});

test('firebase-config initialises Firestore with the modern persistent cache API', () => {
    assert.match(CONFIG, /initializeFirestore/);
    assert.match(CONFIG, /persistentLocalCache/);
    assert.match(CONFIG, /persistentMultipleTabManager/);
});

test('firebase-config wires a persistent onAuthStateChanged listener', () => {
    assert.match(CONFIG, /onAuthStateChanged\(auth/);
});

test('firebase-config sets browserLocalPersistence so auth survives reloads', () => {
    assert.match(CONFIG, /setPersistence\(auth,\s*browserLocalPersistence\)/);
});

test('firebase-config exposes the cross-tab channel and CHANNEL_MESSAGE_TYPES', () => {
    assert.match(CONFIG, /createCrossTabChannel/);
    assert.match(CONFIG, /CHANNEL_MESSAGE_TYPES/);
    assert.match(CONFIG, /export\s+const\s+crossTabChannel/);
});

test('firebase-config broadcasts AUTH_CHANGED to peer tabs on uid change', () => {
    assert.match(CONFIG, /crossTabChannel\.publish\(\s*CHANNEL_MESSAGE_TYPES\.AUTH_CHANGED/);
});

test('firebase-config re-fires local listeners when a peer broadcasts AUTH_CHANGED', () => {
    assert.match(CONFIG, /crossTabChannel\.subscribe\(\s*CHANNEL_MESSAGE_TYPES\.AUTH_CHANGED/);
    assert.match(CONFIG, /notifyAuthListeners/);
});

test('firebase-config exposes window.firebaseAuth adapter for non-module callers', () => {
    assert.match(CONFIG, /window\.firebaseAuth\s*=/);
    assert.match(CONFIG, /onAuthStateChange\b/);
    assert.match(CONFIG, /isSignedIn\b/);
    assert.match(CONFIG, /getCurrentUser\b/);
    assert.match(CONFIG, /ready\b/);
});

test('firebase-config dispatches firebaseAuthReady so deferred scripts can hook in', () => {
    assert.match(CONFIG, /firebaseAuthReady/);
});

test('firebase-config still talks to the v10 modular SDK only (no compat re-introduction)', () => {
    // The history comment intentionally narrates the retired compat SDK,
    // so we strip comments before pattern-matching to avoid a false positive.
    const stripped = CONFIG
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(stripped, /firebase-app-compat/);
    assert.doesNotMatch(stripped, /firebase-auth-compat/);
});

/* -------------------- Canonical-location guard -------------------- */

function collectFiles(dir, predicate, acc = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) collectFiles(full, predicate, acc);
        else if (predicate(entry)) acc.push(full);
    }
    return acc;
}

test('no app file calls initializeApp() — only firebase-config.js may', () => {
    const jsFiles = collectFiles(
        REPO_ROOT,
        (name) => /\.(m?js|html)$/i.test(name) && !name.endsWith('.min.js')
    );

    const offenders = [];
    for (const file of jsFiles) {
        if (file.endsWith('firebase-config.js')) continue;
        if (file.includes('/tests/')) continue;
        // Skip jQuery & other vendored libs that legitimately have an
        // unrelated `initializeApp` symbol (none in this repo today,
        // but cheap to be defensive).
        const text = readFileSync(file, 'utf8');
        // Match `initializeApp(` only if preceded by an import or call;
        // local helpers named `initializeApp` are fine (football-h2h.js
        // declares one for its DOM init).
        if (/\bfrom\s+['"][^'"]*firebase-app['"][\s\S]{0,200}initializeApp/.test(text)) {
            offenders.push(file);
        }
        if (/import\s*\{\s*[^}]*\binitializeApp\b/.test(text)) {
            offenders.push(file);
        }
    }
    assert.deepEqual(offenders, [], `Firebase init must only live in firebase-config.js. Offenders:\n  ${offenders.join('\n  ')}`);
});

test('no app file imports Firestore directly except the sync layer', () => {
    const jsFiles = collectFiles(
        REPO_ROOT,
        (name) => /\.m?js$/i.test(name) && !name.endsWith('.min.js')
    );

    // firebase-config.js is the canonical init point — it must import the
    // Firestore SDK. storage-sync-robust.js is the only consumer-side
    // sync module allowed to talk to Firestore. Everything else is wrong.
    const allowed = new Set([
        join(REPO_ROOT, 'firebase-config.js'),
        join(REPO_ROOT, 'sync-system/storage-sync-robust.js')
    ]);

    const offenders = [];
    for (const file of jsFiles) {
        if (allowed.has(file)) continue;
        if (file.includes('/tests/')) continue;
        if (file.includes('/node_modules/')) continue;
        const text = readFileSync(file, 'utf8');
        if (/firebasejs\/[0-9.]+\/firebase-firestore\.js/.test(text)) {
            offenders.push(file);
        }
    }
    assert.deepEqual(offenders, [], `Direct Firestore imports must go through the sync module. Offenders:\n  ${offenders.join('\n  ')}`);
});

test('the retired firebase-persistence shim is gone from disk and from every HTML import', () => {
    const allFiles = collectFiles(REPO_ROOT, (name) => /\.(m?js|html)$/i.test(name));
    const offenders = [];
    for (const file of allFiles) {
        if (file.includes('/tests/')) continue;
        const text = readFileSync(file, 'utf8');
        // We allow textual mentions inside source comments (the firebase-config
        // history block intentionally references the retired name); we forbid
        // any live import or <script src=...> reference.
        if (/<script[^>]*\bsrc\s*=\s*["'][^"']*firebase-persistence[^"']*["']/i.test(text)) {
            offenders.push(file + ' (script tag)');
        }
        if (/from\s+['"][^'"]*firebase-persistence[^'"]*['"]/.test(text)) {
            offenders.push(file + ' (import)');
        }
    }
    assert.deepEqual(offenders, [], `firebase-persistence references remain:\n  ${offenders.join('\n  ')}`);
});
