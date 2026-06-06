'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { slugify, assignSlugs } = require('../scripts/slugify.cjs');
const { renderExercisePage, buildDescription, labelOf } = require('../scripts/render-exercise-page.cjs');
const { renderExerciseIndex, renderTaxonomyPage } = require('../scripts/render-exercise-index.cjs');
const { renderExercisesSitemap } = require('../scripts/render-sitemap.cjs');

// The legacy inline back-to-top class, assembled from parts so this token
// never appears as a literal in the repo — a `grep -rl` for it must return
// nothing now that the shared sitewide back-to-top is the only implementation.
const LEGACY_SCROLL_TOP_TOKEN = ['ex', 'scroll', 'top'].join('-');

const SAMPLE = [
  { id: 1, name: 'Archer Push-Ups', category: 'chest', muscleGroup: 'pectorals', secondaryMuscles: ['triceps', 'core'], equipment: 'bodyweight', exerciseType: 'reps' },
  { id: 2, name: 'Cable Y Raise', category: 'shoulders', muscleGroup: 'rear-delts', equipment: 'cable', exerciseType: 'reps' },
  { id: 3, name: 'Cable Y Raise', category: 'shoulders', muscleGroup: 'side-delts', equipment: 'cable', exerciseType: 'reps' },
  { id: 4, name: 'Barbell Back Squat', category: 'quads', muscleGroup: 'quads', secondaryMuscles: ['glutes', 'hamstrings'], equipment: 'barbell', exerciseType: 'reps' },
];

test('slugify produces clean URL slugs', () => {
  assert.equal(slugify('Archer Push-Ups'), 'archer-push-ups');
  assert.equal(slugify('Cable Y Raise'), 'cable-y-raise');
  assert.equal(slugify('21s Barbell Curl'), '21s-barbell-curl');
});

test('slugify falls back for empty/garbage input', () => {
  assert.equal(slugify(''), 'exercise');
  assert.equal(slugify(null), 'exercise');
});

test('assignSlugs disambiguates collisions with the id suffix', () => {
  const slugs = assignSlugs(SAMPLE);
  // The two "Cable Y Raise" entries must end up with distinct slugs.
  assert.equal(slugs.get(2), 'cable-y-raise-2');
  assert.equal(slugs.get(3), 'cable-y-raise-3');
  // Unique names stay clean.
  assert.equal(slugs.get(1), 'archer-push-ups');
  assert.equal(slugs.get(4), 'barbell-back-squat');
});

test('labelOf converts kebab-case to Title Case', () => {
  assert.equal(labelOf('rear-delts'), 'Rear Delts');
  assert.equal(labelOf('resistance-band'), 'Resistance Band');
  assert.equal(labelOf('chest'), 'Chest');
});

test('renderExercisePage produces a valid HTML5 document', () => {
  const html = renderExercisePage({
    exercise: SAMPLE[0],
    slug: 'archer-push-ups',
    related: [{ slug: 'incline-push-ups', name: 'Incline Push-Ups', equipment: 'bodyweight' }],
    builtAt: '2026-05-18T00:00:00.000Z',
  });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.trim().endsWith('</html>'));
  // The page uses the shared sitewide back-to-top: it pulls in the shared
  // stylesheet and script, and emits no bespoke inline button or script.
  assert.ok(html.includes('<link rel="stylesheet" href="/assets/css/back-to-top.css">'), 'shared back-to-top stylesheet must be linked');
  assert.ok(html.includes('<script src="/assets/js/back-to-top.js" defer></script>'), 'shared back-to-top script must be included');
  assert.ok(!html.includes(LEGACY_SCROLL_TOP_TOKEN), 'no bespoke inline back-to-top markup or script must be emitted');
});

test('renderExercisePage embeds canonical and ExerciseAction JSON-LD', () => {
  const html = renderExercisePage({ exercise: SAMPLE[0], slug: 'archer-push-ups', related: [], builtAt: '2026-05-18T00:00:00.000Z' });
  assert.ok(html.includes('<link rel="canonical" href="https://shevato.com/apps/gym-tracker/exercises/archer-push-ups/">'));
  assert.ok(html.includes('"@type": "ExerciseAction"'));
  assert.ok(html.includes('"@type": "Muscle"'));
  assert.ok(html.includes('"name": "Pectorals"'));
});

test('renderExercisePage XSS-escapes hostile fields', () => {
  const evil = { ...SAMPLE[0], name: '<script>alert(1)</script>' };
  const html = renderExercisePage({ exercise: evil, slug: 'x', related: [], builtAt: '2026-05-18T00:00:00.000Z' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderExercisePage links into the SPA exercise database view', () => {
  const html = renderExercisePage({ exercise: SAMPLE[0], slug: 'archer-push-ups', related: [], builtAt: '2026-05-18T00:00:00.000Z' });
  assert.ok(html.includes('/apps/gym-tracker/#exercises'));
});

test('buildDescription stays under 300 chars and mentions key facts', () => {
  const d = buildDescription(SAMPLE[3]);
  assert.ok(d.length <= 300);
  assert.ok(d.toLowerCase().includes('barbell'));
  assert.ok(d.toLowerCase().includes('quads'));
});

test('renderExerciseIndex emits every exercise as a link', () => {
  const slugs = assignSlugs(SAMPLE);
  const html = renderExerciseIndex(SAMPLE, slugs, '2026-05-18T00:00:00.000Z');
  for (const ex of SAMPLE) {
    assert.ok(html.includes(`/apps/gym-tracker/exercises/${slugs.get(ex.id)}/`));
  }
  assert.ok(html.includes(`${SAMPLE.length} exercises`));
  assert.ok(html.includes('<link rel="stylesheet" href="/assets/css/back-to-top.css">'), 'shared back-to-top stylesheet must be linked on index');
  assert.ok(html.includes('<script src="/assets/js/back-to-top.js" defer></script>'), 'shared back-to-top script must be included on index');
  assert.ok(!html.includes(LEGACY_SCROLL_TOP_TOKEN), 'no bespoke inline back-to-top markup or script must be emitted on index');
});

test('renderTaxonomyPage targets a high-volume query', () => {
  const slugs = assignSlugs(SAMPLE);
  const html = renderTaxonomyPage({
    kind: 'muscle',
    key: 'pectorals',
    label: 'Pectorals',
    exercises: [SAMPLE[0]],
    slugs,
    builtAt: '2026-05-18T00:00:00.000Z',
  });
  assert.ok(html.includes('<title>Pectorals Exercises (1)'));
  assert.ok(html.includes('canonical" href="https://shevato.com/apps/gym-tracker/exercises/muscle/pectorals/"'));
  assert.ok(html.includes('/apps/gym-tracker/exercises/archer-push-ups/'));
  assert.ok(html.includes('<link rel="stylesheet" href="/assets/css/back-to-top.css">'), 'shared back-to-top stylesheet must be linked on taxonomy page');
  assert.ok(html.includes('<script src="/assets/js/back-to-top.js" defer></script>'), 'shared back-to-top script must be included on taxonomy page');
  assert.ok(!html.includes(LEGACY_SCROLL_TOP_TOKEN), 'no bespoke inline back-to-top markup or script must be emitted on taxonomy page');
});

test('renderExercisesSitemap covers per-exercise, taxonomy, and index URLs', () => {
  const slugs = assignSlugs(SAMPLE);
  const xml = renderExercisesSitemap({
    exercises: SAMPLE,
    slugs,
    muscles: ['pectorals', 'rear-delts', 'side-delts', 'quads'],
    equipment: ['bodyweight', 'cable', 'barbell'],
    builtAt: '2026-05-18T00:00:00.000Z',
  });
  assert.ok(xml.startsWith('<?xml version="1.0"'));
  assert.ok(xml.includes('https://shevato.com/apps/gym-tracker/exercises/</loc>'));
  assert.ok(xml.includes('https://shevato.com/apps/gym-tracker/exercises/muscle/pectorals/</loc>'));
  assert.ok(xml.includes('https://shevato.com/apps/gym-tracker/exercises/equipment/cable/</loc>'));
  assert.ok(xml.includes('https://shevato.com/apps/gym-tracker/exercises/archer-push-ups/</loc>'));
  // Count locs: index + 4 muscles + 3 equipment + 4 exercises = 12
  const locs = (xml.match(/<loc>/g) || []).length;
  assert.equal(locs, 1 + 4 + 3 + SAMPLE.length);
});
