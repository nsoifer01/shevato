'use strict';

// The guard on the data the site actually serves.
//
// WHY THIS FILE EXISTS: every other test here builds a small fixture and
// asserts against it, which is right for testing the build logic and leaves
// the 66,000-record file that ships validated by nothing. The refresh workflow
// is the only place the real dataset exists (it is gitignored and lives on a
// GitHub release), so validate-dataset.js runs there, and this file is what
// proves the validator itself works: a checker nobody checks is worse than no
// checker, because it reads like coverage.
//
// Each case is a dataset that is WRONG in one specific way, plus a control
// that a healthy dataset passes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateDataset, DEFAULT_MIN_COUNT } = require('../scripts/validate-dataset.js');

/** A minimal record that passes every check. */
function record(over = {}) {
  return Object.assign({
    seriesId: 'tt0000001',
    title: 'A Show',
    season: 1,
    firstRating: 7.0,
    lastRating: 8.0,
    avgRating: 7.5,
    shapes: ['rising'],
    episodes: [{ episode: 1, rating: 7.0 }, { episode: 2, rating: 8.0 }],
  }, over);
}

/**
 * A healthy dataset of `n` records. The count floor is the validator's own
 * default, so the fixture is built to clear it rather than the test lowering
 * the bar it is meant to be testing.
 */
function dataset(over = {}, n = DEFAULT_MIN_COUNT) {
  const matches = [];
  for (let i = 0; i < n; i++) {
    matches.push(record({ seriesId: `tt${String(i).padStart(7, '0')}` }));
  }
  return Object.assign({
    builtAt: '2026-09-04T06:00:00.000Z',
    count: matches.length,
    shapeCounts: { rising: matches.length },
    matches,
  }, over);
}

const fails = (data, opts) => {
  const r = validateDataset(data, opts);
  assert.equal(r.ok, false, `expected this dataset to be refused, got: ${JSON.stringify(r.problems)}`);
  return r.problems.join(' | ');
};

// --------------------------------------------------------------- the control

test('a healthy dataset is publishable', () => {
  const r = validateDataset(dataset());
  assert.equal(r.ok, true, `a good dataset must pass: ${r.problems.join(' | ')}`);
  assert.equal(r.stats.records, DEFAULT_MIN_COUNT);
  assert.equal(r.stats.series, DEFAULT_MIN_COUNT);
  assert.equal(r.stats.builtAt, '2026-09-04T06:00:00.000Z');
});

// ------------------------------------------------------- the catalogue itself

test('a truncated build is refused, which is the failure that matters most', () => {
  // The whole point: a refresh that produces a fraction of the catalogue must
  // not replace the release asset. The previous one staying live is the safe
  // outcome.
  const small = dataset({}, 12);
  small.count = 12;
  small.shapeCounts = { rising: 12 };
  assert.match(fails(small), /below the \d+ floor|looks truncated/);
});

test('the header must describe the body', () => {
  const d = dataset();
  d.count = 999;
  assert.match(fails(d), /header says count=999 but there are/);
});

test('an unreadable builtAt is refused', () => {
  assert.match(fails(dataset({ builtAt: 'the other day' })), /builtAt is not a readable timestamp/);
});

test('a dataset with no matches array is refused outright', () => {
  assert.match(fails({ builtAt: '2026-09-04T06:00:00.000Z' }), /`matches` is missing or is not an array/);
  assert.match(fails(null), /not an object/);
});

// -------------------------------------------------------- individual records

test('records that cannot be rendered are refused', () => {
  const noId = dataset();
  noId.matches[3] = record({ seriesId: '' });
  assert.match(fails(noId), /1 records have no seriesId/);

  const noTitle = dataset();
  noTitle.matches[3] = record({ seriesId: 'tt9999999', title: '' });
  assert.match(fails(noTitle), /1 records have no title/);

  const noEpisodes = dataset();
  noEpisodes.matches[3] = record({ seriesId: 'tt9999998', episodes: [] });
  assert.match(fails(noEpisodes), /1 records have no usable episode list/);
});

test('a duplicated season record is refused', () => {
  const d = dataset();
  d.matches[5] = record({ seriesId: d.matches[4].seriesId, season: d.matches[4].season });
  assert.match(fails(d), /1 duplicate \(seriesId, season\) records/);
});

test('ratings outside the IMDb scale, or non-finite, are refused', () => {
  for (const bad of [11, -1, Number.NaN, 'eight', null]) {
    const d = dataset();
    d.matches[7] = record({ seriesId: 'tt9999997', avgRating: bad });
    assert.match(fails(d), /outside 0-10 or a non-finite one/, `avgRating ${String(bad)} must be refused`);
  }
  // Also inside the episode list, which is what the season page renders.
  const ep = dataset();
  ep.matches[8] = record({ seriesId: 'tt9999996', episodes: [{ episode: 1, rating: 42 }] });
  assert.match(fails(ep), /outside 0-10/);
});

// ------------------------------------------------ the shapes the app sorts on

test('a "rising" season that ends lower than it started is refused', () => {
  // The check worth having. A classifier regression ships silently otherwise:
  // the finder still renders, the counts still add up, and "rising" simply
  // stops meaning rising.
  const d = dataset();
  d.matches[9] = record({ seriesId: 'tt9999995', firstRating: 8.5, lastRating: 6.0, shapes: ['rising'] });
  assert.match(fails(d), /1 seasons are tagged "rising" but end lower than they started/);
});

test('a "declining" season that ends higher than it started is refused', () => {
  const d = dataset();
  d.matches[9] = record({ seriesId: 'tt9999994', firstRating: 6.0, lastRating: 8.5, shapes: ['declining'] });
  d.shapeCounts = { rising: d.matches.length - 1, declining: 1 };
  assert.match(fails(d), /1 seasons are tagged "declining" but end higher than they started/);
});

test('rounding noise is not treated as a direction change', () => {
  // A flat season that drifts by less than a tenth of a point must not be
  // reported: this guard exists to catch a broken classifier, not float noise.
  const d = dataset();
  d.matches[9] = record({ seriesId: 'tt9999993', firstRating: 7.0, lastRating: 6.98, shapes: ['rising'] });
  const r = validateDataset(d);
  assert.equal(r.ok, true, `a 0.02 drift must not be reported: ${r.problems.join(' | ')}`);
});

test('the header shape tally must match the records', () => {
  const d = dataset();
  d.shapeCounts = { rising: 5 };
  assert.match(fails(d), /shapeCounts says 5 "rising" but \d+ records carry it/);
});

test('every problem is reported, not just the first', () => {
  // The refresh operator should see the whole picture in one run.
  const d = dataset();
  d.count = 1;
  d.builtAt = 'nope';
  d.matches[2] = record({ seriesId: '', avgRating: 99 });
  const r = validateDataset(d);
  assert.equal(r.ok, false);
  assert.ok(r.problems.length >= 3, `expected several problems, got ${JSON.stringify(r.problems)}`);
});
