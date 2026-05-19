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
    //
    // Explicit exceptions live here. brain-arena/success.html is the
    // Stripe Checkout return URL: it is intentionally a sibling of
    // index.html so the URL stays short (`/apps/brain-arena/success.html`)
    // and the page can reuse the app's CSS. It is `noindex` so it never
    // competes for the canonical app URL in search.
    const apps = listDirs(APPS_DIR);
    const allowedExtras = {
        'brain-arena': new Set(['success.html'])
    };
    const offenders = [];
    for (const app of apps) {
        const appDir = join(APPS_DIR, app);
        const topLevelHtml = readdirSync(appDir).filter(
            (name) => name.endsWith('.html') && statSync(join(appDir, name)).isFile()
        );
        const allowed = allowedExtras[app] || new Set();
        const extras = topLevelHtml.filter((name) => name !== 'index.html' && !allowed.has(name));
        if (extras.length) offenders.push(`${app}: ${extras.join(', ')}`);
    }
    assert.deepEqual(offenders, [], `unexpected top-level HTML beside index.html:\n  ${offenders.join('\n  ')}`);
});

// Concatenates every sitemap XML in the repo into one string so the
// assertions below pass whether app URLs live in the legacy flat
// sitemap.xml or, post-split, in sitemap-pages.xml referenced by the
// sitemap-index at sitemap.xml. Excludes the auto-generated
// sitemap-shows.xml and sitemap-exercises.xml — those are per-app
// children and never carry app-root URLs.
function readSitemapContent() {
    const files = ['sitemap.xml', 'sitemap-pages.xml'];
    let out = '';
    for (const f of files) {
        try {
            out += '\n' + readFileSync(join(REPO_ROOT, f), 'utf8');
        } catch {
            // ok — sitemap-pages.xml is optional if everything is still flat.
        }
    }
    return out;
}

test('apps.html and the sitemap link to every app via the directory form /apps/<name>/', () => {
    // We link to the directory (not /index.html) so that the rendered URL,
    // the canonical tag, the sitemap entry, and the user-facing href all
    // agree — Netlify's pretty-URLs would otherwise redirect /index.html
    // off and break that alignment.
    const appsHtml = readFileSync(join(REPO_ROOT, 'apps.html'), 'utf8');
    const sitemap = readSitemapContent();

    const apps = listDirs(APPS_DIR);
    const missing = [];
    for (const app of apps) {
        // Match the href closing quote in apps.html (href="apps/<name>/")
        // and the loc closing tag in any sitemap file (.../apps/<name>/</loc>)
        // so we don't accidentally match deeper sub-paths.
        const hrefPattern = new RegExp(`href="apps/${app}/"`);
        const locPattern = new RegExp(`apps/${app}/</loc>`);
        if (!hrefPattern.test(appsHtml)) missing.push(`apps.html → href="apps/${app}/"`);
        if (!locPattern.test(sitemap)) missing.push(`sitemap → apps/${app}/</loc>`);
    }
    assert.deepEqual(missing, [], `links/loc entries missing:\n  ${missing.join('\n  ')}`);
});

test('apps.html and the sitemap never expose /apps/<name>/index.html as a URL', () => {
    // Guards against drift back to the /index.html form, which would put
    // the markup out of sync with Netlify's pretty-URL behavior.
    const appsHtml = readFileSync(join(REPO_ROOT, 'apps.html'), 'utf8');
    const sitemap = readSitemapContent();

    const apps = listDirs(APPS_DIR);
    const offenders = [];
    for (const app of apps) {
        const bad = `apps/${app}/index.html`;
        if (appsHtml.includes(bad)) offenders.push(`apps.html → ${bad}`);
        if (sitemap.includes(bad)) offenders.push(`sitemap → ${bad}`);
    }
    assert.deepEqual(offenders, [], `unexpected /index.html URL forms:\n  ${offenders.join('\n  ')}`);
});

test('sitemap.xml is a sitemap-index that references every sub-sitemap', () => {
    // The root sitemap is a <sitemapindex> wrapper so a single submission
    // to Google Search Console covers the page, show, and exercise
    // sub-sitemaps without us having to keep three submissions in sync.
    const index = readFileSync(join(REPO_ROOT, 'sitemap.xml'), 'utf8');
    assert.match(index, /<sitemapindex /, 'sitemap.xml should be a sitemapindex, not a flat urlset');
    const required = [
        'https://shevato.com/sitemap-pages.xml',
        'https://shevato.com/apps/rising-seasons/sitemap-shows.xml',
        'https://shevato.com/apps/gym-tracker/sitemap-exercises.xml',
    ];
    const missing = required.filter((u) => !index.includes(`<loc>${u}</loc>`));
    assert.deepEqual(missing, [], `sitemap-index missing references:\n  ${missing.join('\n  ')}`);
});

test('robots.txt advertises exactly the sitemap-index URL', () => {
    // Once we moved to a sitemap-index, listing the child sitemaps in
    // robots.txt is redundant. Google discovers them through the index.
    const robots = readFileSync(join(REPO_ROOT, 'robots.txt'), 'utf8');
    const sitemapLines = robots.split(/\r?\n/).filter((l) => /^Sitemap:/i.test(l.trim()));
    assert.equal(sitemapLines.length, 1, `expected one Sitemap: line in robots.txt, got ${sitemapLines.length}`);
    assert.match(sitemapLines[0], /https:\/\/shevato\.com\/sitemap\.xml\s*$/);
});

test('netlify.toml keeps a 301 from tracker.html to the new mario-kart entry', () => {
    const toml = readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf8');
    assert.match(toml, /from\s*=\s*"\/apps\/mario-kart\/tracker\.html"/);
    // Target is the directory form so the redirect lands on the
    // pretty-URL canonical in a single hop.
    assert.match(toml, /to\s*=\s*"\/apps\/mario-kart\/"/);
    assert.match(toml, /status\s*=\s*301/);
});
