'use strict';

const { labelOf, escapeHtml, SITE } = require('./render-exercise-page.cjs');
const { renderMoreFooter, renderScrollTopButton } = require('./render-footer.cjs');

// Master /exercises/ landing page. Groups every exercise under its
// primary muscle group with anchor jumps. Internal links here let
// Google reach every per-exercise page through one crawl entry.
function renderExerciseIndex(exercises, slugs, builtAt) {
  const byMuscle = groupBy(exercises, (e) => e.muscleGroup || e.category);
  const muscles = [...byMuscle.keys()].sort();
  const total = exercises.length;
  const description = `Browse all ${total} exercises in Gym Tracker by muscle group and equipment. Muscles worked, equipment needed, and tracking type for every exercise in the database.`;
  const canonical = `${SITE}/apps/gym-tracker/exercises/`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>All Exercises | Gym Tracker — Browse by Muscle Group & Equipment</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="author" content="Shevato LLC">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#1a1a2e">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${canonical}">

  <meta property="og:title" content="All Exercises | Gym Tracker">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE}/images/full-logo.svg">

  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE}/home.html" },
        { "@type": "ListItem", "position": 2, "name": "Apps", "item": "${SITE}/apps.html" },
        { "@type": "ListItem", "position": 3, "name": "Gym Tracker", "item": "${SITE}/apps/gym-tracker/" },
        { "@type": "ListItem", "position": 4, "name": "Exercises", "item": "${canonical}" }
      ]
    }
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
      <a href="/apps/gym-tracker/exercises/" aria-current="page">All exercises</a>
      <a href="/apps.html">More apps</a>
    </nav>
  </header>

  <main id="main" class="exercises-index">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Shevato</a> ›
      <a href="/apps/gym-tracker/">Gym Tracker</a> ›
      <span>Exercises</span>
    </nav>

    <header class="index-hero">
      <h1>All exercises</h1>
      <p class="lede">${total} exercises grouped by muscle. Each links to a page with muscles worked, equipment, and tracking type.</p>
    </header>

    <nav class="alpha-jump" aria-label="Jump to muscle group">
      ${muscles.map((m) => `<a href="#muscle-${escapeHtml(m)}">${escapeHtml(labelOf(m))}</a>`).join('')}
    </nav>

    ${muscles
      .map((m) => {
        const items = byMuscle.get(m).sort((a, b) => a.name.localeCompare(b.name));
        return `<section class="alpha-group" id="muscle-${escapeHtml(m)}">
      <h2><a href="/apps/gym-tracker/exercises/muscle/${escapeHtml(m)}/">${escapeHtml(labelOf(m))}</a> <span class="muted">(${items.length})</span></h2>
      <ul class="shows-list">
        ${items
          .map((ex) => `<li><a href="/apps/gym-tracker/exercises/${slugs.get(ex.id)}/">${escapeHtml(ex.name)}<span class="muted"> · ${escapeHtml(labelOf(ex.equipment))}</span></a></li>`)
          .join('\n        ')}
      </ul>
    </section>`;
      })
      .join('\n    ')}

    <p class="index-footer">Last updated ${builtAt ? new Date(builtAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)}.</p>
  </main>

  ${renderMoreFooter()}
  ${renderScrollTopButton()}
</body>
</html>
`;
}

// Single-muscle or single-equipment landing page — short, fast, and
// targets the high-volume query directly (e.g. "lats exercises",
// "dumbbell exercises"). The filter callback decides which exercises
// belong on the page.
function renderTaxonomyPage({ kind, key, label, exercises, slugs, builtAt }) {
  const path = `/apps/gym-tracker/exercises/${kind}/${key}/`;
  const canonical = `${SITE}${path}`;
  const sorted = [...exercises].sort((a, b) => a.name.localeCompare(b.name));
  const description = `${sorted.length} ${label.toLowerCase()} exercises with muscles worked, equipment, and tracking type. Free workout logger included.`;
  const pageTitle = `${label} Exercises (${sorted.length}) — Muscles & Equipment | Gym Tracker`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#1a1a2e">
  <meta name="color-scheme" content="dark">
  <link rel="canonical" href="${canonical}">

  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE}/images/full-logo.svg">

  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE}/home.html" },
        { "@type": "ListItem", "position": 2, "name": "Apps", "item": "${SITE}/apps.html" },
        { "@type": "ListItem", "position": 3, "name": "Gym Tracker", "item": "${SITE}/apps/gym-tracker/" },
        { "@type": "ListItem", "position": 4, "name": "Exercises", "item": "${SITE}/apps/gym-tracker/exercises/" },
        { "@type": "ListItem", "position": 5, "name": "${escapeHtml(label)}", "item": "${canonical}" }
      ]
    }
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

  <main id="main" class="exercises-index">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Shevato</a> ›
      <a href="/apps/gym-tracker/">Gym Tracker</a> ›
      <a href="/apps/gym-tracker/exercises/">Exercises</a> ›
      <span>${escapeHtml(label)}</span>
    </nav>

    <header class="index-hero">
      <h1>${escapeHtml(label)} exercises</h1>
      <p class="lede">${sorted.length} ${escapeHtml(label.toLowerCase())} exercises. Each links to a page with muscles worked, equipment, and tracking type.</p>
    </header>

    <ul class="shows-list grid-2">
      ${sorted
        .map((ex) => `<li><a href="/apps/gym-tracker/exercises/${slugs.get(ex.id)}/">${escapeHtml(ex.name)}<span class="muted"> · ${escapeHtml(labelOf(ex.equipment))}</span></a></li>`)
        .join('\n      ')}
    </ul>

    <p class="index-footer"><a href="/apps/gym-tracker/exercises/">Browse all exercises →</a></p>
  </main>

  ${renderMoreFooter()}
  ${renderScrollTopButton()}
</body>
</html>
`;
}

function groupBy(arr, fn) {
  const out = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(x);
  }
  return out;
}

module.exports = { renderExerciseIndex, renderTaxonomyPage, groupBy };
