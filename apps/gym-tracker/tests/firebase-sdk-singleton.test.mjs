// Regression guard: enforce that no HTML page loads the v9 compat
// Firebase SDK alongside the v10 modular SDK.
//
// Loading both SDKs creates two separate `<authDomain>/__/auth/iframe`
// frames; each iframe loads `apis.google.com/js/api.js?onload=__iframefcb<id>`
// and registers a callback on `window`. On mobile the two iframes
// race over those callback slots and gapi.js throws
// `Uncaught TypeError: u[v] is not a function`. firebase-config.js is
// the single source of auth state — it exposes `window.firebaseAuth`
// for non-module callers. This test fails if anyone re-introduces a
// compat script tag on any page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FORBIDDEN_PATTERNS = [
    /firebase-app-compat\.js/i,
    /firebase-auth-compat\.js/i,
    /firebasejs\/9\.\d+\.\d+\/firebase-(app|auth|firestore|database)-compat/i
];

function collectHtmlFiles(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            collectHtmlFiles(full, acc);
        } else if (entry.endsWith('.html')) {
            acc.push(full);
        }
    }
    return acc;
}

test('no HTML file loads the Firebase v9 compat SDK', () => {
    const htmlFiles = collectHtmlFiles(REPO_ROOT);
    assert.ok(htmlFiles.length > 0, 'expected to find HTML files in the repo');

    const offenders = [];
    for (const file of htmlFiles) {
        const content = readFileSync(file, 'utf8');
        // Strip HTML comments so historical context inside <!-- ... -->
        // doesn't trip the guard. We only care about live <script> tags.
        const stripped = content.replace(/<!--[\s\S]*?-->/g, '');
        for (const pattern of FORBIDDEN_PATTERNS) {
            if (pattern.test(stripped)) {
                offenders.push(`${file} matches ${pattern}`);
            }
        }
    }

    assert.deepEqual(
        offenders,
        [],
        `Found compat-SDK references — they cause the mobile __iframefcb race:\n  ${offenders.join('\n  ')}`
    );
});

test('firebase-config.js declares the window.firebaseAuth adapter', () => {
    const config = readFileSync(join(REPO_ROOT, 'firebase-config.js'), 'utf8');
    assert.match(config, /window\.firebaseAuth\s*=/, 'firebase-config.js must expose window.firebaseAuth');
    assert.match(config, /firebaseAuthReady/, 'firebase-config.js must dispatch the firebaseAuthReady event');
    assert.match(config, /onAuthStateChanged/, 'firebase-config.js must wire the modular onAuthStateChanged');
});
