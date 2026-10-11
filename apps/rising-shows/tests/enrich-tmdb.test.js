'use strict';

// The daily refresh retries every posterless or not-found TMDB row. Each retry
// used to replace the cached row outright, discarding the providers and season
// fields later passes had added, so those were re-fetched every single run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeResolvedRow } = require('../scripts/enrich-tmdb.js');

const prev = {
  id: 42, poster_path: null, overview: 'old', original_language: 'en',
  providers: [{ id: 8 }], seasonTvdbIds: { 1: 7 }, seasonOverviews: { 1: 's1' },
};

test('a retry that lands on the same TMDB show keeps the fields later passes added', () => {
  const row = mergeResolvedRow(prev, { id: 42, poster_path: '/p.jpg', overview: 'new', cast: [] });
  assert.equal(row.poster_path, '/p.jpg');
  assert.equal(row.overview, 'new');
  assert.deepEqual(row.providers, [{ id: 8 }]);
  assert.deepEqual(row.seasonTvdbIds, { 1: 7 });
  assert.deepEqual(row.seasonOverviews, { 1: 's1' });
});

test('a retry that lands on a different show starts clean', () => {
  const row = mergeResolvedRow(prev, { id: 99, poster_path: '/q.jpg' });
  assert.deepEqual(row, { id: 99, poster_path: '/q.jpg' });
});

test('a failed lookup keeps a matched row and records the error otherwise', () => {
  assert.equal(mergeResolvedRow(prev, null, new Error('TMDB 500')), prev);
  assert.deepEqual(mergeResolvedRow({ notFound: true }, null, new Error('TMDB 500')), { error: 'TMDB 500' });
  assert.deepEqual(mergeResolvedRow(undefined, null, new Error('x')), { error: 'x' });
});

test('a not-found result still replaces whatever was there', () => {
  assert.deepEqual(mergeResolvedRow({ notFound: true }, { notFound: true }), { notFound: true });
  assert.deepEqual(mergeResolvedRow(undefined, { id: 1 }), { id: 1 });
});
