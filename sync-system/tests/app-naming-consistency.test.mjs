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
    // Explicit exceptions live here. arena/success.html is the Stripe
    // Checkout return URL: it is intentionally a sibling of index.html
    // so the URL stays short (`/apps/arena/success.html`) and the page
    // can reuse the app's CSS. It is `noindex` so it never competes for
    // the canonical app URL in search.
    const apps = listDirs(APPS_DIR);
    const allowedExtras = {
        'arena': new Set(['success.html'])
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
        'https://shevato.com/apps/rising-shows/sitemap-shows.xml',
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

// ---------------------------------------------------------------------------
// Cross-cutting invariant: every user-facing list of apps is in A-Z order.
//
// The owner's rule is that apps are ALWAYS listed alphabetically. Before this
// test the site disagreed with itself: the header nav and the apps.html
// JSON-LD were alphabetical, apps.html's visible cards were alphabetical
// except Gym Tracker hoisted to first, the homepage grid was in no order at
// all, and both README lists and the sitemap followed a fourth arbitrary
// order. Ordering is exactly the kind of thing that drifts silently every
// time an app is added, so it is asserted rather than remembered.
// ---------------------------------------------------------------------------

/** Case-insensitive compare, so "MapTap" sorts before "Mario" on 'p' < 'r'. */
function isSortedCI(names) {
    const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return names.join('|') === sorted.join('|');
}

function readRepoFile(...parts) {
    return readFileSync(join(REPO_ROOT, ...parts), 'utf8');
}

test('the homepage app grid is in A-Z order', () => {
    const html = readRepoFile('home.html');
    const names = [...html.matchAll(/href="apps\/[a-z0-9-]+\/">([^<]*)<span>/g)].map((m) => m[1].trim());
    assert.equal(names.length, 8, 'expected all eight apps in the homepage grid');
    assert.ok(isSortedCI(names), `homepage grid out of A-Z order: ${names.join(', ')}`);
});

test('the apps hub cards are in A-Z order', () => {
    const html = readRepoFile('apps.html');
    const section = html.slice(html.indexOf('<div class="highlights">'));
    const names = [...section.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1].trim());
    assert.equal(names.length, 8, 'expected all eight app cards');
    assert.ok(isSortedCI(names), `apps.html cards out of A-Z order: ${names.join(', ')}`);
});

test('the header nav app menu is in A-Z order', () => {
    const html = readRepoFile('partials', 'header.html');
    // The nav renders twice (desktop dropdown + mobile list); check each run
    // separately rather than the concatenation, which would never be sorted.
    const links = [...html.matchAll(/href="\/apps\/[a-z0-9-]+\/"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
    assert.equal(links.length, 16, 'expected eight apps in each of the two nav blocks');
    const desktop = links.slice(0, 8);
    const mobile = links.slice(8);
    assert.ok(isSortedCI(desktop), `header desktop nav out of A-Z order: ${desktop.join(', ')}`);
    assert.ok(isSortedCI(mobile), `header mobile nav out of A-Z order: ${mobile.join(', ')}`);
});

test('the apps hub CollectionPage JSON-LD lists apps in A-Z order', () => {
    const html = readRepoFile('apps.html');
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const names = [];
    for (const [, raw] of blocks) {
        const parsed = JSON.parse(raw); // also asserts the JSON-LD stays valid
        for (const part of parsed.hasPart || []) {
            if (part.name) names.push(part.name);
        }
    }
    assert.equal(names.length, 8, 'expected all eight apps in hasPart');
    assert.ok(isSortedCI(names), `apps.html JSON-LD out of A-Z order: ${names.join(', ')}`);
});

test('the sitemap lists the app landing pages in A-Z order', () => {
    const xml = readRepoFile('sitemap-pages.xml');
    const slugs = [...xml.matchAll(/<loc>https:\/\/shevato\.com\/apps\/([a-z0-9-]+)\/<\/loc>/g)].map((m) => m[1]);
    assert.equal(slugs.length, 8, 'expected eight app landing pages in the sitemap');
    assert.ok(isSortedCI(slugs), `sitemap app order not A-Z: ${slugs.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The canonical app manifest, and the generated-page footers that consume it.
//
// Added 2026-08-12 after an audit failure: the FPL Planner was registered on
// every surface THIS suite tested (apps.html, homepage, sitemap) while the
// static show/exercise pages generated by the two render-footer scripts still
// advertised the previous app inventory, because those scripts hand-duplicated
// the list with a "keep in sync" comment and nothing here read them. The list
// now lives in assets/apps-manifest.json, both generators render from it, and
// these tests make the whole chain one invariant: directories on disk ==
// manifest == every tested surface == generated-page footers. Adding an app
// without touching the manifest, or touching the manifest without the surfaces
// following, fails here.
// ---------------------------------------------------------------------------

const MANIFEST_PATH = join(REPO_ROOT, 'assets', 'apps-manifest.json');

test('the app manifest exists and lists exactly the directories under apps/, A-Z', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const slugs = manifest.apps.map((a) => a.slug);
    const dirs = listDirs(APPS_DIR).sort();
    assert.deepEqual(slugs.slice().sort(), dirs, 'manifest slugs must match apps/ directories exactly');
    assert.deepEqual(slugs, slugs.slice().sort(), 'manifest must be A-Z');
    for (const app of manifest.apps) {
        assert.ok(app.name && app.name.trim().length > 1, `${app.slug} needs a name`);
        assert.ok(app.blurb && app.blurb.trim().length > 5, `${app.slug} needs a footer blurb`);
    }
});

test('both static-page footer generators render every manifest app and nothing else', async () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const { createRequire } = await import('node:module');
    const require_ = createRequire(import.meta.url);
    const footers = [
        ['rising-shows', require_(join(APPS_DIR, 'rising-shows', 'scripts', 'render-footer.js')).renderMoreFooter()],
        ['gym-tracker', require_(join(APPS_DIR, 'gym-tracker', 'scripts', 'render-footer.cjs')).renderMoreFooter()],
    ];
    for (const [label, html] of footers) {
        // Every manifest app appears exactly once, as the directory-form link
        // with its manifest name.
        for (const app of manifest.apps) {
            const link = `href="/apps/${app.slug}/"`;
            const count = html.split(link).length - 1;
            assert.equal(count, 1, `${label} footer must link ${app.slug} exactly once`);
            assert.ok(html.includes(`<strong>${app.name}</strong>`), `${label} footer must name ${app.name}`);
        }
        // And no app link that the manifest does not know: a stale or invented
        // entry is exactly the drift this file exists to stop.
        const linked = [...html.matchAll(/href="\/apps\/([a-z0-9-]+)\//g)].map((m) => m[1]);
        const known = new Set(manifest.apps.map((a) => a.slug));
        const strays = linked.filter((slug) => !known.has(slug));
        assert.deepEqual(strays, [], `${label} footer links apps the manifest does not list`);
        // The footers must agree with each other on the list (same source, but
        // pin it so a future fork of one generator cannot drift silently).
        assert.deepEqual(linked, manifest.apps.map((a) => a.slug), `${label} footer order must be the manifest order`);
    }
});

test('every tested surface lists every manifest app', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const surfaces = [
        ['apps.html', readFileSync(join(REPO_ROOT, 'apps.html'), 'utf8')],
        ['home.html', readFileSync(join(REPO_ROOT, 'home.html'), 'utf8')],
        ['partials/header.html', readFileSync(join(REPO_ROOT, 'partials', 'header.html'), 'utf8')],
        ['sitemap-pages.xml', readFileSync(join(REPO_ROOT, 'sitemap-pages.xml'), 'utf8')],
    ];
    const missing = [];
    for (const [label, content] of surfaces) {
        for (const app of manifest.apps) {
            if (!content.includes(`apps/${app.slug}/`)) missing.push(`${label} -> ${app.slug}`);
        }
    }
    assert.deepEqual(missing, []);
});
