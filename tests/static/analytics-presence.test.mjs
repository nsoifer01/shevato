// Every indexable page loads GA4 exactly once, through the shared helper.
//
// assets/js/analytics.js is the single place GA4 is configured: it owns the
// measurement id, guards against double boot, and is the only API the apps
// may call. A page that forgets the gtag loader or the helper silently
// disappears from GA4 (the 2026-08-07 analytics round found two app pages
// with no tag at all); a page that carries the pair twice, or a second
// gtag loader with a different G- id, fires duplicate page_views and
// pollutes the property. Neither failure mode produces an error anywhere.
//
// Pages: every root page except the apex stub (index.html, 301'd at the
// edge), the Search Console token and the OG card template (rendered
// headless, never served), every app index and the Kometa builder. The
// five deploy-time generator templates are rendered with minimal fixtures
// so the check runs against real template output, not a grep of source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const require = createRequire(import.meta.url);

// -- The one measurement id ----------------------------------------------------------

const ANALYTICS_JS = read('assets/js/analytics.js');
const MEASUREMENT_ID = (ANALYTICS_JS.match(/MEASUREMENT_ID\s*=\s*'(G-[A-Z0-9]+)'/) || [])[1];

test('assets/js/analytics.js declares exactly one measurement id', () => {
  assert.ok(MEASUREMENT_ID, 'could not read MEASUREMENT_ID from analytics.js');
  const ids = new Set(ANALYTICS_JS.match(/G-[A-Z0-9]{6,}/g));
  assert.deepEqual([...ids], [MEASUREMENT_ID], 'analytics.js must name one G- id only');
});

// -- Shared counting -------------------------------------------------------------------

const gtagLoaders = (html) =>
  [...html.matchAll(/<script\b[^>]*\bsrc=["']https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=(G-[A-Z0-9]+)["'][^>]*>/gi)]
    .map((m) => m[1]);
const helperScripts = (html) =>
  [...html.matchAll(/<script\b[^>]*\bsrc=["']((?:\/|(?:\.\.\/)+)assets\/js\/analytics\.js)["'][^>]*>/gi)]
    .map((m) => m[1]);

function assertTaggedOnce(label, html) {
  const loaders = gtagLoaders(html);
  assert.equal(loaders.length, 1, `${label}: expected one gtag.js loader, found ${loaders.length}`);
  assert.equal(loaders[0], MEASUREMENT_ID, `${label}: gtag loader uses ${loaders[0]}, not ${MEASUREMENT_ID}`);
  const helpers = helperScripts(html);
  assert.equal(helpers.length, 1, `${label}: expected one analytics.js script, found ${helpers.length} (${helpers.join(', ')})`);
  // Any other G- id anywhere in a script tag is a second property.
  const strayIds = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>|<script\b[^>]*\/?>/gi)]
    .flatMap((m) => m[0].match(/G-[A-Z0-9]{6,}/g) || [])
    .filter((id) => id !== MEASUREMENT_ID);
  assert.deepEqual(strayIds, [], `${label}: a second measurement id appears in a script tag`);
}

// -- Committed pages -----------------------------------------------------------------------

const manifest = JSON.parse(read('assets/apps-manifest.json'));
const PAGES = [
  'home.html', 'work.html', 'apps.html', 'about.html', 'contact.html', 'privacy.html',
  'moadon-alef.html', '404.html',
  ...manifest.apps.map((a) => `apps/${a.slug}/index.html`),
  'apps/rising-shows/kometa/index.html',
];

for (const page of PAGES) {
  test(`${page} loads gtag.js and analytics.js exactly once`, () => {
    assertTaggedOnce(page, read(page));
  });
}

// -- Generator templates, rendered ----------------------------------------------------------

const BUILT_AT = '2026-05-18T00:00:00.000Z';
const SHOW = {
  seriesId: 'tt0903747', title: 'Breaking Bad', year: 2008, type: 'tvSeries', genres: ['Drama'],
  seriesRating: 9.5, seriesVotes: 2615545, poster: '/poster.jpg', overview: 'Walter White becomes a meth cook.',
  language: 'en', providers: ['Netflix'], tmdbId: 1396,
  seasons: [{
    season: 1, seasonYear: 2008,
    episodes: [{ episode: 1, rating: 8.0, votes: 1000, name: 'Pilot' }, { episode: 2, rating: 8.2, votes: 950, name: 'Cat' }],
    firstRating: 8.0, lastRating: 8.2, avgRating: 8.1, shapes: ['rising'],
  }],
  builtAt: BUILT_AT,
};
const EXERCISE = { id: 1, name: 'Barbell Back Squat', category: 'quads', muscleGroup: 'quads',
  secondaryMuscles: ['glutes'], equipment: 'barbell', exerciseType: 'reps' };

const GENERATORS = {
  'apps/rising-shows/scripts/render-show-page.js': (m) => m.renderShowPage(SHOW),
  'apps/rising-shows/scripts/render-shows-index.js': (m) => m.renderShowsIndex([SHOW], BUILT_AT),
  'apps/rising-shows/scripts/render-shape-hub.js': (m) => m.renderShapeHub('rising', [SHOW], BUILT_AT),
  'apps/gym-tracker/scripts/render-exercise-page.cjs': (m) =>
    m.renderExercisePage({ exercise: EXERCISE, slug: 'barbell-back-squat', related: [], builtAt: BUILT_AT }),
  'apps/gym-tracker/scripts/render-exercise-index.cjs': (m) =>
    m.renderExerciseIndex([EXERCISE], new Map([[1, 'barbell-back-squat']]), BUILT_AT),
};

for (const [file, render] of Object.entries(GENERATORS)) {
  test(`${file} output loads gtag.js and analytics.js exactly once`, () => {
    const html = render(require(join(REPO_ROOT, file)));
    assert.ok(typeof html === 'string' && html.includes('<html'), `${file} did not render a document`);
    assertTaggedOnce(file, html);
  });
}
