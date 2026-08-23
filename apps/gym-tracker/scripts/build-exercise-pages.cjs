#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { assignSlugs } = require('./slugify.cjs');
const { renderExercisePage } = require('./render-exercise-page.cjs');
const { renderExerciseIndex, renderTaxonomyPage, groupBy } = require('./render-exercise-index.cjs');
const { renderExercisesSitemap } = require('./render-sitemap.cjs');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'exercises-db.json');
const OUT_DIR = path.join(ROOT, 'exercises');
const SITEMAP_FILE = path.join(ROOT, 'sitemap-exercises.xml');

const RELATED_LIMIT = 12;

/**
 * The taxonomy directories the build emits under /exercises/muscle/.
 *
 * Leaf pages link their Category to `/exercises/muscle/<category>/` and
 * their breadcrumb to `/exercises/muscle/<muscleGroup>/`, so BOTH vocabularies
 * need a directory. Categories that never equal a muscleGroup (`back`,
 * `chest`, `cardio`) used to get none, and 155 leaf pages carried a 404 link
 * on production (2026-08-22 audit, D6). A category page lists every exercise
 * of that category; a muscle page lists every exercise of that primary
 * muscle; when one key serves both, the muscle grouping wins (it did before).
 */
function collectMuscleTaxonomy(exercises) {
  const byMuscle = groupBy(exercises, (e) => e.muscleGroup || e.category);
  const byCategory = groupBy(exercises, (e) => e.category);
  for (const [cat, items] of byCategory.entries()) {
    if (cat && !byMuscle.has(cat)) byMuscle.set(cat, items);
  }
  return byMuscle;
}

function main({ outDir = OUT_DIR, sitemapFile = SITEMAP_FILE, log = console.log } = {}) {
  const exercises = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!Array.isArray(exercises)) throw new Error('exercises-db.json is not an array');
  const slugs = assignSlugs(exercises);
  const builtAt = new Date().toISOString();
  log(`[build-exercise-pages] ${exercises.length} exercises`);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Build a muscleGroup → exercises map once, for related-links and
  // taxonomy pages.
  const byMuscle = collectMuscleTaxonomy(exercises);
  const byEquipment = groupBy(exercises, (e) => e.equipment);

  let pageCount = 0;
  for (const ex of exercises) {
    const slug = slugs.get(ex.id);
    const dir = path.join(outDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    const peers = (byMuscle.get(ex.muscleGroup || ex.category) || [])
      .filter((p) => p.id !== ex.id)
      .slice(0, RELATED_LIMIT)
      .map((p) => ({ slug: slugs.get(p.id), name: p.name, equipment: p.equipment }));
    const html = renderExercisePage({ exercise: ex, slug, related: peers, builtAt });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    pageCount++;
  }

  // Browse index
  fs.writeFileSync(path.join(outDir, 'index.html'), renderExerciseIndex(exercises, slugs, builtAt));

  // Muscle-group landing pages
  const muscleDir = path.join(outDir, 'muscle');
  fs.mkdirSync(muscleDir, { recursive: true });
  for (const [m, items] of byMuscle.entries()) {
    const subdir = path.join(muscleDir, m);
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(
      path.join(subdir, 'index.html'),
      renderTaxonomyPage({ kind: 'muscle', key: m, label: labelize(m), exercises: items, slugs, builtAt }),
    );
  }

  // Equipment landing pages
  const eqDir = path.join(outDir, 'equipment');
  fs.mkdirSync(eqDir, { recursive: true });
  for (const [e, items] of byEquipment.entries()) {
    const subdir = path.join(eqDir, e);
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(
      path.join(subdir, 'index.html'),
      renderTaxonomyPage({ kind: 'equipment', key: e, label: labelize(e), exercises: items, slugs, builtAt }),
    );
  }

  // Sitemap
  fs.writeFileSync(
    sitemapFile,
    renderExercisesSitemap({
      exercises,
      slugs,
      muscles: [...byMuscle.keys()],
      equipment: [...byEquipment.keys()],
      builtAt,
    }),
  );

  const taxoCount = byMuscle.size + byEquipment.size;
  log(`[build-exercise-pages] wrote ${pageCount} exercise pages + ${taxoCount} taxonomy pages + index + sitemap`);
}

function labelize(s) {
  return String(s || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[build-exercise-pages] FAILED:', e.message);
    process.exit(1);
  }
}

module.exports = { main, collectMuscleTaxonomy };
