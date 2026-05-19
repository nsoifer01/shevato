'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { slugify, showPath } = require('../scripts/slugify.js');

test('slugify lowercases and dashes', () => {
  assert.equal(slugify('Breaking Bad'), 'breaking-bad');
  assert.equal(slugify('Game of Thrones'), 'game-of-thrones');
});

test('slugify strips punctuation and collapses dashes', () => {
  assert.equal(slugify("It's Always Sunny in Philadelphia"), 'it-s-always-sunny-in-philadelphia');
  assert.equal(slugify('Brooklyn Nine-Nine'), 'brooklyn-nine-nine');
  assert.equal(slugify('Marvel’s Daredevil: Born Again'), 'marvel-s-daredevil-born-again');
});

test('slugify converts ampersands to "and"', () => {
  assert.equal(slugify('Will & Grace'), 'will-and-grace');
  assert.equal(slugify('Tom & Jerry'), 'tom-and-jerry');
});

test('slugify handles non-ASCII titles', () => {
  // Falls back to dropping any chars that aren't a-z0-9.
  // Result is non-empty fallback when title is all non-ASCII.
  assert.equal(slugify('進撃の巨人'), 'show');
  // Mixed scripts keep the ASCII parts.
  assert.equal(slugify('Sherlock 神探'), 'sherlock');
});

test('slugify caps length at 80 chars', () => {
  const long = 'A'.repeat(200);
  assert.ok(slugify(long).length <= 80);
});

test('slugify handles empty/garbage input', () => {
  assert.equal(slugify(''), 'show');
  assert.equal(slugify(null), 'show');
  assert.equal(slugify(undefined), 'show');
  assert.equal(slugify('!!!'), 'show');
});

test('showPath combines slug with seriesId', () => {
  assert.equal(showPath('Breaking Bad', 'tt0903747'), 'breaking-bad-tt0903747');
  assert.equal(showPath('The Office', 'tt0386676'), 'the-office-tt0386676');
});

test('showPath guarantees uniqueness via seriesId for colliding titles', () => {
  // "The Office" exists multiple times on IMDb (US, UK, etc.) — the tconst
  // suffix ensures URLs never collide even when slugs do.
  const usOffice = showPath('The Office', 'tt0386676');
  const ukOffice = showPath('The Office', 'tt0290978');
  assert.notEqual(usOffice, ukOffice);
});
