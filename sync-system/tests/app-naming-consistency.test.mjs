// Cross-cutting invariant: every app under /apps must use index.html
// as its entry filename. Anything else (older "tracker.html", future
// drift) is caught here so the sitemap, canonical URLs, and nav links
// can stay coherent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APPS_DIR = join(REPO_ROOT, 'apps');

function listDirs(dir) {
    return readdirSync(dir).filter((name) => {
        if (name.startsWith('.')) return false;
        const full = join(dir, name);
        return statSync(full).isDirectory();
    });
}

test('every app directory contains index.html as the entry point', () => {
    const apps = listDirs(APPS_DIR);
    assert.ok(apps.length >= 4, 'expected at least 4 app directories');

    const missing = [];
    for (const app of apps) {
        const entry = join(APPS_DIR, app, 'index.html');
        try {
            statSync(entry);
        } catch {
            missing.push(app);
        }
    }
    assert.deepEqual(missing, [], `apps missing index.html: ${missing.join(', ')}`);
});

test('no app directory contains a stray non-index *.html entry alongside index.html', () => {
    // Apps may host secondary HTML files in subdirs (docs, help pages) but the
    // top-level of each app must have exactly one index.html and no other
    // entry candidates that would compete for "primary URL" status.
    const apps = listDirs(APPS_DIR);
    const offenders = [];
    for (const app of apps) {
        const appDir = join(APPS_DIR, app);
        const topLevelHtml = readdirSync(appDir).filter(
            (name) => name.endsWith('.html') && statSync(join(appDir, name)).isFile()
        );
        // index.html is the only blessed entry; everything else is suspicious
        // at the top level. (None of the current apps need a secondary
        // top-level HTML; if that changes, this test is the right place to
        // declare the exception.)
        const extras = topLevelHtml.filter((name) => name !== 'index.html');
        if (extras.length) offenders.push(`${app}: ${extras.join(', ')}`);
    }
    assert.deepEqual(offenders, [], `unexpected top-level HTML beside index.html:\n  ${offenders.join('\n  ')}`);
});

test('apps.html and sitemap.xml link to every app via /apps/<name>/index.html', () => {
    const appsHtml = readFileSync(join(REPO_ROOT, 'apps.html'), 'utf8');
    const sitemap = readFileSync(join(REPO_ROOT, 'sitemap.xml'), 'utf8');

    const apps = listDirs(APPS_DIR);
    const missing = [];
    for (const app of apps) {
        const expected = `apps/${app}/index.html`;
        // apps.html and sitemap may use either relative or full URL form.
        if (!appsHtml.includes(expected)) missing.push(`apps.html → ${expected}`);
        if (!sitemap.includes(expected)) missing.push(`sitemap.xml → ${expected}`);
    }
    assert.deepEqual(missing, [], `links/loc entries missing:\n  ${missing.join('\n  ')}`);
});

test('netlify.toml keeps a 301 from tracker.html to the new mario-kart entry', () => {
    const toml = readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf8');
    assert.match(toml, /from\s*=\s*"\/apps\/mario-kart\/tracker\.html"/);
    assert.match(toml, /to\s*=\s*"\/apps\/mario-kart\/index\.html"/);
    assert.match(toml, /status\s*=\s*301/);
});
