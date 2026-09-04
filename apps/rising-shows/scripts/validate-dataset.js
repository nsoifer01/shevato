#!/usr/bin/env node
'use strict';

// Validate the dataset THIS BUILD produced, before it is published.
//
// WHY THIS EXISTS: every test under apps/rising-shows/tests builds its own
// small fixture and asserts against that, which is the right way to test the
// build logic. The consequence is that the 66,000-record file the site
// actually serves is validated by nothing at all. The refresh workflow
// uploads it to the rolling release and merges its bot PR with GITHUB_TOKEN,
// and GitHub does not start workflow runs from GITHUB_TOKEN events, so the
// `tests` and `browser tests` runs queued against a bot PR never execute.
// Even if they did they would skip every data-dependent check, because the
// dataset is gitignored and absent on a runner. The refresh job is the only
// place the real data exists, so it is the only place it can be checked.
//
// This is deliberately about the DATA, not the code: shape classifications
// that contradict the ratings they were derived from, records that cannot be
// rendered, a catalogue that silently collapsed to a fraction of its size.
// Anything a unit test can cover belongs in a unit test instead.
//
//   node apps/rising-shows/scripts/validate-dataset.js [--data <path>] [--min-count N]
//
// Exits 0 when the dataset is publishable, 1 with a numbered report when it is
// not. Nothing is written; this only reads.

const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// A refresh that produces a small fraction of the previous catalogue is a
// broken build, not a quiet day at IMDb. The floor is deliberately far below
// the real figure (66,380 season records on 2026-08-22) so ordinary churn
// never trips it, while a truncation or an empty parse does.
const DEFAULT_MIN_COUNT = 20000;

// Ratings are IMDb's 1-10 scale. Anything outside it means the parse or the
// average went wrong.
const MIN_RATING = 0;
const MAX_RATING = 10;

// A tenth of an IMDb point, halved: rounding noise only, not a real move.
const TOLERANCE = 0.05;

/**
 * Check one already-parsed dataset object.
 *
 * Pure and exported so a unit test can drive it with a small fixture; the CLI
 * below is only file reading, argument handling and reporting.
 *
 * @param {object} data parsed data.json
 * @param {{minCount?: number}} [opts]
 * @returns {{ok: boolean, problems: string[], stats: object}}
 */
function validateDataset(data, opts = {}) {
  const minCount = Number.isFinite(opts.minCount) ? opts.minCount : DEFAULT_MIN_COUNT;
  const problems = [];
  const say = (msg) => problems.push(msg);

  if (!data || typeof data !== 'object') {
    return { ok: false, problems: ['the dataset is not an object'], stats: {} };
  }

  // --- the header describes the body -------------------------------------
  const rows = data.matches;
  if (!Array.isArray(rows)) {
    return { ok: false, problems: ['`matches` is missing or is not an array'], stats: {} };
  }
  if (typeof data.builtAt !== 'string' || Number.isNaN(Date.parse(data.builtAt))) {
    say(`builtAt is not a readable timestamp: ${JSON.stringify(data.builtAt)}`);
  }
  if (data.count !== rows.length) {
    say(`the header says count=${data.count} but there are ${rows.length} records`);
  }
  if (rows.length < minCount) {
    say(`only ${rows.length} records, which is below the ${minCount} floor: this build looks truncated`);
  }

  // --- every record can be rendered --------------------------------------
  const seen = new Set();
  let duplicates = 0;
  let badRating = 0;
  let badEpisodes = 0;
  let missingId = 0;
  let missingTitle = 0;
  const ratingOk = (v) => typeof v === 'number' && Number.isFinite(v)
    && v >= MIN_RATING && v <= MAX_RATING;

  for (const r of rows) {
    if (!r || typeof r !== 'object') { badEpisodes++; continue; }
    if (typeof r.seriesId !== 'string' || !r.seriesId) missingId++;
    if (typeof r.title !== 'string' || !r.title) missingTitle++;

    const key = `${r.seriesId} ${r.season}`;
    if (seen.has(key)) duplicates++;
    else seen.add(key);

    if (!ratingOk(r.avgRating) || !ratingOk(r.firstRating) || !ratingOk(r.lastRating)) badRating++;

    if (!Array.isArray(r.episodes) || r.episodes.length === 0) badEpisodes++;
    else if (r.episodes.some((e) => !e || !ratingOk(e.rating))) badRating++;
  }

  if (missingId) say(`${missingId} records have no seriesId`);
  if (missingTitle) say(`${missingTitle} records have no title`);
  if (duplicates) say(`${duplicates} duplicate (seriesId, season) records`);
  if (badRating) say(`${badRating} records carry a rating outside ${MIN_RATING}-${MAX_RATING} or a non-finite one`);
  if (badEpisodes) say(`${badEpisodes} records have no usable episode list`);

  // --- the shape a record claims agrees with its own ratings -------------
  //
  // This is the check worth having. A shape is what the whole app sorts,
  // filters and builds hub pages on, and a classifier regression would ship
  // silently: the finder would still render, the counts would still add up,
  // and "rising" would simply stop meaning rising. Two directional shapes are
  // checkable from the record alone, without re-deriving the classifier
  // (which would be a mirror of the thing under test).
  let risingThatFalls = 0;
  let decliningThatRises = 0;

  for (const r of rows) {
    if (!r || !Array.isArray(r.shapes)) continue;
    if (!ratingOk(r.firstRating) || !ratingOk(r.lastRating)) continue;
    if (r.shapes.includes('rising') && r.lastRating < r.firstRating - TOLERANCE) risingThatFalls++;
    if (r.shapes.includes('declining') && r.lastRating > r.firstRating + TOLERANCE) decliningThatRises++;
  }
  if (risingThatFalls) {
    say(`${risingThatFalls} seasons are tagged "rising" but end lower than they started`);
  }
  if (decliningThatRises) {
    say(`${decliningThatRises} seasons are tagged "declining" but end higher than they started`);
  }

  // --- the header's shape tally matches the records ----------------------
  if (data.shapeCounts && typeof data.shapeCounts === 'object') {
    const actual = new Map();
    for (const r of rows) {
      for (const s of (r && Array.isArray(r.shapes) ? r.shapes : [])) {
        actual.set(s, (actual.get(s) || 0) + 1);
      }
    }
    for (const [shape, claimed] of Object.entries(data.shapeCounts)) {
      const real = actual.get(shape) || 0;
      if (real !== claimed) say(`shapeCounts says ${claimed} "${shape}" but ${real} records carry it`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    stats: {
      records: rows.length,
      series: new Set(rows.map((r) => r && r.seriesId)).size,
      builtAt: data.builtAt,
      shapes: data.shapeCounts ? Object.keys(data.shapeCounts).length : 0,
    },
  };
}

module.exports = { validateDataset, DEFAULT_MIN_COUNT };

if (require.main === module) {
  const file = arg('--data', path.join(APP_DIR, 'data.json'));
  const minCount = Number(arg('--min-count', DEFAULT_MIN_COUNT));

  if (!fs.existsSync(file)) {
    console.error(`validate-dataset: ${file} does not exist`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`validate-dataset: ${file} is not readable JSON: ${err.message}`);
    process.exit(1);
  }

  const { ok, problems, stats } = validateDataset(parsed, { minCount });
  console.log(`validate-dataset: ${stats.records} season records across ${stats.series} series, built ${stats.builtAt}`);

  if (ok) {
    console.log('validate-dataset: the dataset is publishable.');
    process.exit(0);
  }

  console.error(`validate-dataset: ${problems.length} problem(s) with the dataset THIS build produced:`);
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}`));
  console.error('Refusing to publish. The previous release asset stays live, which is the safe outcome.');
  process.exit(1);
}
