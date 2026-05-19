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
        // index.html is the only blessed entry; everything else is su[redacted]ious
        // at the top level. (None of the current apps need a secondary
        // top-level HTML; if that changes, this test is the right place to
        // declare the exception.)
        const extras = topLevelHtml.filter((name) => name !== 'index.html');
        if (extras.length) offenders.push(`${app}: ${extras.join(', ')}`);
    }
    assert.deepEqual(offenders, [], `unexpected top-level HTML beside index.html:\n  ${offenders.join('\n  ')}`);
});

test('apps.html and sitemap.xml link to every app via the directory form /apps/<name>/', () => {
    // We link to the directory (not /index.html) so that the rendered URL,
    // the canonical tag, the sitemap entry, and the user-facing href all
    // agree — Netlify's pretty-URLs would otherwise redirect /index.html
    // off and break that alignment.
    const appsHtml = readFileSync(join(REPO_ROOT, 'apps.html'), 'utf8');
    const sitemap = readFileSync(join(REPO_ROOT, 'sitemap.xml'), 'utf8');

    const apps = listDirs(APPS_DIR);
    const missing = [];
    for (const app of apps) {
        // Match the href closing quote in apps.html (href="apps/<name>/")
        // and the loc closing tag in the sitemap (.../apps/<name>/</loc>)
        // so we don't accidentally match deeper sub-paths.
        const hrefPattern = new RegExp(`href="apps/${app}/"`);
        const locPattern = new RegExp(`apps/${app}/</loc>`);
        if (!hrefPattern.test(appsHtml)) missing.push(`apps.html → href="apps/${app}/"`);
        if (!locPattern.test(sitemap)) missing.push(`sitemap.xml → apps/${app}/</loc>`);
    }
    assert.deepEqual(missing, [], `links/loc entries missing:\n  ${missing.join('\n  ')}`);
});

test('apps.html and sitemap.xml never expose /apps/<name>/index.html as a URL', () => {
    // Guards against drift back to the /index.html form, which would put
    // the markup out of sync with Netlify's pretty-URL behavior.
    const appsHtml = readFileSync(join(REPO_ROOT, 'apps.html'), 'utf8');
    const sitemap = readFileSync(join(REPO_ROOT, 'sitemap.xml'), 'utf8');

    const apps = listDirs(APPS_DIR);
    const offenders = [];
    for (const app of apps) {
        const bad = `apps/${app}/index.html`;
        if (appsHtml.includes(bad)) offenders.push(`apps.html → ${bad}`);
        if (sitemap.includes(bad)) offenders.push(`sitemap.xml → ${bad}`);
    }
    assert.deepEqual(offenders, [], `unexpected /index.html URL forms:\n  ${offenders.join('\n  ')}`);
});

test('netlify.toml keeps a 301 from tracker.html to the new mario-kart entry', () => {
    const toml = readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf8');
    assert.match(toml, /from\s*=\s*"\/apps\/mario-kart\/tracker\.html"/);
    // Target is the directory form so the redirect lands on the
    // pretty-URL canonical in a single hop.
    assert.match(toml, /to\s*=\s*"\/apps\/mario-kart\/"/);
    assert.match(toml, /status\s*=\s*301/);
});
