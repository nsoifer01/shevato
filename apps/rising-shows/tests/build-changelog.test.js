'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { diffDatasets, appendEntry } = require('../scripts/build-changelog.js');

function ep(episode, rating, votes = 1000) {
  return { episode, rating, votes, tconst: `tt${episode}` };
}

function match(seriesId, title, season, overrides = {}) {
  return {
    seriesId,
    title,
    season,
    seasonYear: 2024,
    year: 2024,
    type: 'tvSeries',
    genres: ['Drama'],
    episodes: [ep(1, 7.0), ep(2, 7.5), ep(3, 8.0), ep(4, 8.5)],
    firstRating: 7.0,
    lastRating: 8.5,
    avgRating: 7.75,
    minVotes: 1000,
    shapes: ['rising'],
    seriesRating: 8.0,
    seriesVotes: 50000,
    ...overrides,
  };
}

function dataset(matches, shapeCounts = {}, builtAt = '2026-05-14T08:00:00.000Z') {
  return {
    builtAt,
    count: matches.length,
    shapeCounts,
    matches,
  };
}

// --- diffDatasets ---

test('diffDatasets flags added seasons', () => {
  const prev = dataset([match('tt1', 'Alpha', 1)]);
  const next = dataset([
    match('tt1', 'Alpha', 1),
    match('tt2', 'Beta', 1, { seasonYear: 2026 }),
  ]);
  const entry = diffDatasets(prev, next);
  assert.equal(entry.added.length, 1);
  assert.equal(entry.added[0].seriesId, 'tt2');
  assert.equal(entry.added[0].title, 'Beta');
  assert.equal(entry.added[0].seasonYear, 2026);
  assert.equal(entry.removed.length, 0);
});

test('diffDatasets flags removed seasons', () => {
  const prev = dataset([match('tt1', 'Alpha', 1), match('tt2', 'Beta', 1)]);
  const next = dataset([match('tt1', 'Alpha', 1)]);
  const entry = diffDatasets(prev, next);
  assert.equal(entry.removed.length, 1);
  assert.equal(entry.removed[0].seriesId, 'tt2');
  assert.equal(entry.added.length, 0);
});

test('diffDatasets distinguishes seasons of the same series', () => {
  const prev = dataset([match('tt1', 'Alpha', 1)]);
  const next = dataset([match('tt1', 'Alpha', 1), match('tt1', 'Alpha', 2)]);
  const entry = diffDatasets(prev, next);
  assert.equal(entry.added.length, 1);
  assert.equal(entry.added[0].season, 2);
});

test('diffDatasets reports totals delta', () => {
  const prev = dataset([match('tt1', 'Alpha', 1)]);
  const next = dataset([match('tt1', 'Alpha', 1), match('tt2', 'Beta', 1)]);
  const entry = diffDatasets(prev, next);
  assert.equal(entry.totals.seasons, 2);
  assert.equal(entry.totals.delta, 1);
});

test('diffDatasets reports per-shape deltas, only non-zero', () => {
  const prev = dataset([], { rising: 10, 'big-finale': 5, consistent: 3 });
  const next = dataset([], { rising: 12, 'big-finale': 5, consistent: 2, 'slow-burn': 1 });
  const entry = diffDatasets(prev, next);
  assert.deepEqual(entry.shapeDeltas, { rising: 2, consistent: -1, 'slow-burn': 1 });
});

test('diffDatasets counts modified fields without listing every season', () => {
  const prev = dataset([
    match('tt1', 'Alpha', 1, { seriesVotes: 100, avgRating: 7.0 }),
    match('tt2', 'Beta', 1, { seriesVotes: 200, shapes: ['rising'] }),
  ]);
  const next = dataset([
    match('tt1', 'Alpha', 1, { seriesVotes: 150, avgRating: 7.1 }),
    match('tt2', 'Beta', 1, { seriesVotes: 200, shapes: ['rising', 'slow-burn'] }),
  ]);
  const entry = diffDatasets(prev, next);
  assert.equal(entry.modifiedCounts.seriesVotes, 1);
  assert.equal(entry.modifiedCounts.avgRating, 1);
  assert.equal(entry.modifiedCounts.shapes, 1);
});

test('diffDatasets surfaces notable rating swings sorted by magnitude', () => {
  const prev = dataset([
    match('tt1', 'Alpha', 1, { avgRating: 7.0 }),
    match('tt2', 'Beta', 1, { avgRating: 8.0 }),
    match('tt3', 'Gamma', 1, { avgRating: 7.5 }),
  ]);
  const next = dataset([
    match('tt1', 'Alpha', 1, { avgRating: 7.05 }), // below threshold
    match('tt2', 'Beta', 1, { avgRating: 8.5 }),   // +0.5
    match('tt3', 'Gamma', 1, { avgRating: 6.5 }),  // -1.0
  ]);
  const entry = diffDatasets(prev, next);
  assert.equal(entry.ratingSwings.length, 2);
  assert.equal(entry.ratingSwings[0].title, 'Gamma');
  assert.equal(entry.ratingSwings[0].delta, -1);
  assert.equal(entry.ratingSwings[1].title, 'Beta');
});

test('diffDatasets handles missing prev (initial build)', () => {
  const next = dataset([match('tt1', 'Alpha', 1)]);
  const entry = diffDatasets(null, next);
  assert.equal(entry.added.length, 1);
  assert.equal(entry.removed.length, 0);
  assert.equal(entry.totals.seasons, 1);
  assert.equal(entry.totals.delta, 1);
});

test('diffDatasets uses next.builtAt for the entry timestamp', () => {
  const prev = dataset([], {}, '2026-05-13T06:00:00.000Z');
  const next = dataset([], {}, '2026-05-14T06:00:00.000Z');
  const entry = diffDatasets(prev, next);
  assert.equal(entry.builtAt, '2026-05-14T06:00:00.000Z');
});

// --- appendEntry ---

test('appendEntry prepends newest entry and caps history', () => {
  const initial = { updates: [
    { builtAt: '2026-05-12T06:00:00.000Z', totals: { seasons: 10, delta: 0 } },
    { builtAt: '2026-05-11T06:00:00.000Z', totals: { seasons: 10, delta: 0 } },
  ] };
  const entry = { builtAt: '2026-05-14T06:00:00.000Z', totals: { seasons: 11, delta: 1 } };
  const result = appendEntry(initial, entry, 2);
  assert.equal(result.updates.length, 2);
  assert.equal(result.updates[0].builtAt, '2026-05-14T06:00:00.000Z');
  assert.equal(result.updates[1].builtAt, '2026-05-12T06:00:00.000Z');
});

test('appendEntry de-duplicates by builtAt (re-running keeps a single entry)', () => {
  const initial = { updates: [
    { builtAt: '2026-05-14T06:00:00.000Z', totals: { seasons: 10, delta: 0 } },
  ] };
  const entry = { builtAt: '2026-05-14T06:00:00.000Z', totals: { seasons: 11, delta: 1 } };
  const result = appendEntry(initial, entry, 5);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].totals.seasons, 11);
});

test('appendEntry handles an empty/missing changelog', () => {
  const entry = { builtAt: '2026-05-14T06:00:00.000Z', totals: { seasons: 1, delta: 1 } };
  const result = appendEntry(null, entry, 5);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].builtAt, '2026-05-14T06:00:00.000Z');
});

// --- missing-baseline guard (CLI) ---
//
// data.json is not committed to git (it lives on the rising-shows-data
// release), so the script's HEAD fallback never finds a baseline. On an
// established changelog that must NOT append a full-catalogue "everything
// added" entry; repeated daily it grew changelog.json past GitHub's 100 MB
// push limit and broke the refresh workflow.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'build-changelog.js');

function runCli(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function tmpDataset() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-changelog-test-'));
  const dataPath = path.join(dir, 'data.json');
  fs.writeFileSync(dataPath, JSON.stringify(dataset([match('tt1', 'Alpha', 1)])));
  return { dir, dataPath, outPath: path.join(dir, 'changelog.json') };
}

test('CLI skips when there is no baseline and the changelog already has entries', () => {
  const { dataPath, outPath } = tmpDataset();
  const existing = { updates: [
    { builtAt: '2026-05-13T06:00:00.000Z', totals: { seasons: 10, delta: 0 }, added: [], removed: [] },
  ] };
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n');
  const before = fs.readFileSync(outPath, 'utf8');
  runCli(['--new', dataPath, '--out', outPath]);
  assert.equal(fs.readFileSync(outPath, 'utf8'), before);
});

test('CLI skips when --prev points at a missing file and the changelog has entries', () => {
  const { dir, dataPath, outPath } = tmpDataset();
  const existing = { updates: [
    { builtAt: '2026-05-13T06:00:00.000Z', totals: { seasons: 10, delta: 0 }, added: [], removed: [] },
  ] };
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n');
  const before = fs.readFileSync(outPath, 'utf8');
  runCli(['--new', dataPath, '--out', outPath, '--prev', path.join(dir, 'nope.json')]);
  assert.equal(fs.readFileSync(outPath, 'utf8'), before);
});

test('CLI still records an initial entry when the changelog is empty', () => {
  const { dataPath, outPath } = tmpDataset();
  runCli(['--new', dataPath, '--out', outPath]);
  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(written.updates.length, 1);
  assert.equal(written.updates[0].added.length, 1);
});

test('CLI appends a normal diff entry when --prev exists', () => {
  const { dir, dataPath, outPath } = tmpDataset();
  const prevPath = path.join(dir, 'prev.json');
  fs.writeFileSync(prevPath, JSON.stringify(dataset([])));
  const existing = { updates: [
    { builtAt: '2026-05-13T06:00:00.000Z', totals: { seasons: 0, delta: 0 }, added: [], removed: [] },
  ] };
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n');
  runCli(['--new', dataPath, '--out', outPath, '--prev', prevPath]);
  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(written.updates.length, 2);
  assert.equal(written.updates[0].added.length, 1);
});
