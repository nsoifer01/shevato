'use strict';

const { labelOf, escapeHtml, SITE } = require('./render-exercise-page.cjs');
const { renderMoreFooter } = require('./render-footer.cjs');

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
  <title>All ${total} Exercises by Muscle Group and Equipment | Gym Tracker</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="author" content="Shevato LLC">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#0a0c14">
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
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE}/home" },
        { "@type": "ListItem", "position": 2, "name": "Apps", "item": "${SITE}/apps" },
        { "@type": "ListItem", "position": 3, "name": "Gym Tracker", "item": "${SITE}/apps/gym-tracker/" },
        { "@type": "ListItem", "position": 4, "name": "Exercises", "item": "${canonical}" }
      ]
    }
  </script>

  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E💪%3C/text%3E%3C/svg%3E">
  <link rel="stylesheet" href="/apps/gym-tracker/css/exercise-page.css">
  <link rel="stylesheet" href="/assets/css/back-to-top.css">

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
      <a href="/apps">More apps</a>
    </nav>
  </header>

  <main id="main" class="exercises-index">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/home">Shevato</a> ›
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
  <script src="/assets/js/back-to-top.js" defer></script>
</body>
</html>
`;
}

// A summary of a taxonomy page, counted from the exercises on it.
// Deliberately derived rather than written: the exercise database holds only
// name, category, muscle group, secondary muscles, equipment and tracking
// type, so this is the whole of what can be said truthfully about a group
// without inventing coaching copy that would be indistinguishable from the
// filler every other exercise site already publishes.
//
// Returns { lede, description }: the lede is the visible intro, the
// description is capped so search results do not truncate it mid-clause.
function taxonomySummary(kind, label, exercises) {
  const n = exercises.length;
  const plural = n === 1 ? 'exercise' : 'exercises';

  if (kind === 'equipment') {
    const muscles = topCounts(exercises.map((e) => e.muscleGroup || e.category), 3)
      .map((m) => labelOf(m).toLowerCase());
    const groups = new Set(exercises.map((e) => e.muscleGroup || e.category)).size;
    // "with a bodyweight" is not English: the bodyweight and other/none
    // buckets are a class of exercise, not a piece of kit you pick up.
    const opener = isBodyweight(label)
      ? `${n} ${label.toLowerCase()} ${plural} that need no equipment`
      : `${n} ${plural} you can do with ${indefinite(label.toLowerCase())}`;
    const lede = `${opener}, covering ${groups} muscle ${groups === 1 ? 'group' : 'groups'}`
      + (muscles.length ? `, most often the ${listPhrase(muscles)}.` : '.');
    return { lede, description: describe(lede) };
  }

  const equipment = topCounts(exercises.map((e) => e.equipment), 3)
    .filter((e) => !isBodyweight(e))
    .map((e) => pluralise(labelOf(e).toLowerCase()));
  const bodyweight = exercises.filter((e) => isBodyweight(e.equipment)).length;
  const secondary = topCounts(exercises.flatMap((e) => e.secondaryMuscles || []), 2)
    .map((m) => labelOf(m).toLowerCase());

  let lede = `${n} ${plural} that primarily work the ${label.toLowerCase()}`;
  if (equipment.length) lede += `, using ${listPhrase(equipment)}`;
  lede += '.';

  const extras = [];
  if (bodyweight) extras.push(`${bodyweight} need no equipment at all`);
  if (secondary.length) extras.push(`many also work the ${listPhrase(secondary)}`);
  if (extras.length) lede += ' ' + sentenceCase(listPhrase(extras)) + '.';

  return { lede, description: describe(lede) };
}

// Meta description: the lede plus a short call to action when both fit inside
// a search snippet, the lede alone when they do not, and only then a trim to
// the last whole sentence. Capping the combined string first threw away a
// perfectly good second sentence to make room for the CTA.
function describe(lede, limit = 158) {
  const cta = 'Free to log in Gym Tracker, no account needed.';
  if (lede.length + 1 + cta.length <= limit) return `${lede} ${cta}`;
  if (lede.length <= limit) return lede;
  const cut = lede.slice(0, limit);
  const stop = cut.lastIndexOf('. ');
  return stop > 60 ? cut.slice(0, stop + 1) : cut.replace(/[\s,;:-]+\S*$/, '') + '.';
}

const isBodyweight = (equipment) => /body ?weight|^none$|^other$/i.test(equipment || '');

// Equipment reads as a class here ("using barbells and cables"), not as one
// object. Names already ending in s are left alone.
function pluralise(word) {
  return /s$/.test(word) ? word : word + 's';
}

// The `limit` most common values, most frequent first, ignoring blanks.
function topCounts(values, limit) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit).map(([v]) => v);
}

// "a", "b and c", "a, b and c" - no serial comma, matching the site's prose.
function listPhrase(items) {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function sentenceCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function indefinite(word) {
  return (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word;
}

// Single-muscle or single-equipment landing page — short, fast, and
// targets the high-volume query directly (e.g. "lats exercises",
// "dumbbell exercises"). The filter callback decides which exercises
// belong on the page.
function renderTaxonomyPage({ kind, key, label, exercises, slugs, builtAt }) {
  const path = `/apps/gym-tracker/exercises/${kind}/${key}/`;
  const canonical = `${SITE}${path}`;
  const sorted = [...exercises].sort((a, b) => a.name.localeCompare(b.name));

  // Title leads with the count and the thing people search for ("pectorals
  // exercises", "barbell exercises") and stays under ~60 characters so the
  // query term is not the half Google truncates. The old form put an em dash
  // and two extra clauses in front of the brand.
  const pageTitle = kind === 'equipment'
    ? `${sorted.length} ${label} Exercises, by Muscle Group | Gym Tracker`
    : `${sorted.length} ${label} Exercises, by Equipment | Gym Tracker`;

  const { lede, description } = taxonomySummary(kind, label, sorted);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#0a0c14">
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
        { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE}/home" },
        { "@type": "ListItem", "position": 2, "name": "Apps", "item": "${SITE}/apps" },
        { "@type": "ListItem", "position": 3, "name": "Gym Tracker", "item": "${SITE}/apps/gym-tracker/" },
        { "@type": "ListItem", "position": 4, "name": "Exercises", "item": "${SITE}/apps/gym-tracker/exercises/" },
        { "@type": "ListItem", "position": 5, "name": "${escapeHtml(label)}", "item": "${canonical}" }
      ]
    }
  </script>

  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E💪%3C/text%3E%3C/svg%3E">
  <link rel="stylesheet" href="/apps/gym-tracker/css/exercise-page.css">
  <link rel="stylesheet" href="/assets/css/back-to-top.css">

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
      <a href="/apps">More apps</a>
    </nav>
  </header>

  <main id="main" class="exercises-index">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/home">Shevato</a> ›
      <a href="/apps/gym-tracker/">Gym Tracker</a> ›
      <a href="/apps/gym-tracker/exercises/">Exercises</a> ›
      <span>${escapeHtml(label)}</span>
    </nav>

    <header class="index-hero">
      <h1>${escapeHtml(label)} exercises</h1>
      <p class="lede">${escapeHtml(lede)}</p>
    </header>

    <ul class="shows-list grid-2">
      ${sorted
        .map((ex) => `<li><a href="/apps/gym-tracker/exercises/${slugs.get(ex.id)}/">${escapeHtml(ex.name)}<span class="muted"> · ${escapeHtml(labelOf(ex.equipment))}</span></a></li>`)
        .join('\n      ')}
    </ul>

    <p class="index-footer"><a href="/apps/gym-tracker/exercises/">Browse all exercises →</a></p>
  </main>

  ${renderMoreFooter()}
  <script src="/assets/js/back-to-top.js" defer></script>
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
