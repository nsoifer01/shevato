'use strict';

const SITE = 'https://shevato.com';

// Human-readable labels for the kebab-case taxonomy in exercises-db.json.
const CATEGORY_LABELS = {
  chest: 'Chest', back: 'Back', shoulders: 'Shoulders', traps: 'Traps',
  neck: 'Neck', biceps: 'Biceps', triceps: 'Triceps', forearms: 'Forearms',
  abs: 'Abs', obliques: 'Obliques', glutes: 'Glutes', quads: 'Quads',
  hamstrings: 'Hamstrings', calves: 'Calves', adductors: 'Adductors',
  abductors: 'Abductors', cardio: 'Cardio',
};

function labelOf(slug) {
  if (CATEGORY_LABELS[slug]) return CATEGORY_LABELS[slug];
  return String(slug || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Render a single static page for one exercise. The `related` list is
// other exercises sharing the same primary muscle group — internal
// links here let Google crawl the whole DB starting from any page.
function renderExercisePage({ exercise, slug, related, builtAt }) {
  const path = `/apps/gym-tracker/exercises/${slug}/`;
  const canonical = `${SITE}${path}`;
  const name = exercise.name;
  const pageTitle = `${name} — Muscles Worked, Equipment & How to Do It | Gym Tracker`;
  const description = buildDescription(exercise);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="author" content="Shevato LLC">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#1a1a2e">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${canonical}">

  <meta property="og:title" content="${escapeHtml(`${name} — Muscles Worked & Equipment`)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE}/images/full-logo.svg">
  <meta property="og:site_name" content="Shevato">
  <meta property="og:locale" content="en_US">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(`${name} | Gym Tracker`)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${SITE}/images/full-logo.svg">
  <meta name="twitter:site" content="@shevato">

  <script type="application/ld+json">
${jsonLd(buildBreadcrumbs(name, path))}
  </script>

  <script type="application/ld+json">
${jsonLd(buildExerciseSchema({ exercise, canonical, description }))}
  </script>

  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E💪%3C/text%3E%3C/svg%3E">
  <link rel="stylesheet" href="/apps/gym-tracker/css/exercise-page.css">

  <script async src="https://www.googletagmanager.com/gtag/js?id=G-GEQGY35JJN"></script>
  <script defer src="/assets/js/analytics.js"></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>

  <header class="page-header">
    <a class="brand" href="/apps/gym-tracker/" aria-label="Gym Tracker home">
      <span aria-hidden="true">💪</span> Gym Tracker
    </a>
    <nav class="page-nav" aria-label="Primary">
      <a href="/apps/gym-tracker/">Tracker</a>
      <a href="/apps/gym-tracker/exercises/">All exercises</a>
      <a href="/apps.html">More apps</a>
    </nav>
  </header>

  <main id="main" class="exercise-page">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Shevato</a> ›
      <a href="/apps/gym-tracker/">Gym Tracker</a> ›
      <a href="/apps/gym-tracker/exercises/">Exercises</a> ›
      <a href="/apps/gym-tracker/exercises/muscle/${escapeHtml(exercise.muscleGroup || exercise.category)}/">${escapeHtml(labelOf(exercise.muscleGroup || exercise.category))}</a> ›
      <span>${escapeHtml(name)}</span>
    </nav>

    <header class="exercise-hero">
      <h1>${escapeHtml(name)}</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <div class="hero-actions">
        <a class="primary-btn" href="/apps/gym-tracker/#exercises">Open in Gym Tracker →</a>
      </div>
    </header>

    <section class="facts">
      <h2 class="visually-hidden">Exercise details</h2>
      <dl class="fact-grid">
        <div><dt>Category</dt><dd><a href="/apps/gym-tracker/exercises/muscle/${escapeHtml(exercise.category)}/">${escapeHtml(labelOf(exercise.category))}</a></dd></div>
        <div><dt>Primary muscle</dt><dd>${escapeHtml(labelOf(exercise.muscleGroup))}</dd></div>
        ${exercise.secondaryMuscles && exercise.secondaryMuscles.length ? `<div><dt>Secondary muscles</dt><dd>${exercise.secondaryMuscles.map((m) => escapeHtml(labelOf(m))).join(', ')}</dd></div>` : ''}
        <div><dt>Equipment</dt><dd><a href="/apps/gym-tracker/exercises/equipment/${escapeHtml(exercise.equipment)}/">${escapeHtml(labelOf(exercise.equipment))}</a></dd></div>
        ${exercise.exerciseType ? `<div><dt>Tracking</dt><dd>${escapeHtml(labelOf(exercise.exerciseType))}</dd></div>` : ''}
      </dl>
    </section>

    ${related && related.length ? `<section class="related">
      <h2>Related ${escapeHtml(labelOf(exercise.muscleGroup))} exercises</h2>
      <ul class="related-list">
        ${related.map((r) => `<li><a href="/apps/gym-tracker/exercises/${r.slug}/">${escapeHtml(r.name)}<span class="muted"> · ${escapeHtml(labelOf(r.equipment))}</span></a></li>`).join('\n        ')}
      </ul>
    </section>` : ''}

    <section class="page-footer-meta">
      <p>Track this exercise (and 500+ others) in <a href="/apps/gym-tracker/">Gym Tracker</a> — a free, installable PWA for logging workouts and tracking strength progress.</p>
      <p class="muted">Last updated ${builtAt ? new Date(builtAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)}.</p>
    </section>
  </main>

  <footer class="page-footer">
    <p>© Shevato LLC · <a href="/">shevato.com</a> · <a href="/contact.html">Contact</a></p>
  </footer>
</body>
</html>
`;
}

function buildDescription(ex) {
  const cat = labelOf(ex.category);
  const primary = labelOf(ex.muscleGroup);
  const eq = labelOf(ex.equipment).toLowerCase();
  const sec = ex.secondaryMuscles && ex.secondaryMuscles.length
    ? ` It also engages the ${ex.secondaryMuscles.map(labelOf).map((s) => s.toLowerCase()).join(', ')}.`
    : '';
  const type = ex.exerciseType === 'duration' ? 'a timed exercise' : ex.exerciseType === 'reps' ? 'tracked by reps and weight' : null;
  const typeStr = type ? ` It is ${type}.` : '';
  const lead = `${ex.name} is a ${cat.toLowerCase()} exercise that primarily targets the ${primary.toLowerCase()}, performed with ${eq}.${sec}${typeStr}`;
  return clip(lead, 300);
}

function clip(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

function buildBreadcrumbs(name, path) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/home.html` },
      { '@type': 'ListItem', position: 2, name: 'Apps', item: `${SITE}/apps.html` },
      { '@type': 'ListItem', position: 3, name: 'Gym Tracker', item: `${SITE}/apps/gym-tracker/` },
      { '@type': 'ListItem', position: 4, name: 'Exercises', item: `${SITE}/apps/gym-tracker/exercises/` },
      { '@type': 'ListItem', position: 5, name: name, item: `${SITE}${path}` },
    ],
  };
}

function buildExerciseSchema({ exercise, canonical, description }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ExerciseAction',
    name: exercise.name,
    url: canonical,
    description,
    exerciseType: exercise.category,
    target: {
      '@type': 'Muscle',
      name: labelOf(exercise.muscleGroup),
    },
    ...(exercise.secondaryMuscles && exercise.secondaryMuscles.length
      ? { additionalType: exercise.secondaryMuscles.map(labelOf) }
      : {}),
    ...(exercise.equipment
      ? { instrument: { '@type': 'SportsActivityLocation', name: labelOf(exercise.equipment) } }
      : {}),
  };
}

function jsonLd(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/<\/(script|style)/gi, '<\\/$1')
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { renderExercisePage, buildDescription, labelOf, SITE, escapeHtml };
