import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGenericQuery, matchConfidence, normalizeQuery } from '../lib/tp-places-match.mjs';

// The rule these tests encode: a rating shown against the wrong venue is worse
// than no rating at all, because the traveller cannot tell it is wrong.

test('normalizeQuery folds punctuation, case and accents', () => {
  assert.equal(normalizeQuery('Ichiran (Shibuya branch)'), 'ichiran shibuya branch');
  assert.equal(normalizeQuery('Café  de  Flore'), 'cafe de flore');
  assert.equal(normalizeQuery(''), '');
  assert.equal(normalizeQuery(null), '');
});

test('category queries are recognised before any billed call is made', () => {
  // These are what the assistant emits for "grab something from a konbini".
  // They resolve to SOME place at Google, never the right one.
  assert.equal(isGenericQuery('Convenience Store (Konbini) Breakfast'), true);
  assert.equal(isGenericQuery('local ramen restaurant'), true);
  assert.equal(isGenericQuery('coffee shop nearby'), true);
  assert.equal(isGenericQuery('street food'), true);
});

test('queries naming an actual venue are not treated as generic', () => {
  assert.equal(isGenericQuery('Ichiran Ramen Shibuya Tokyo'), false);
  assert.equal(isGenericQuery('teamLab Planets TOKYO'), false);
  assert.equal(isGenericQuery('7-Eleven Shinjuku'), false, 'a named chain branch is findable');
});

test('a place whose name the query contains is a confident match', () => {
  const m = matchConfidence('Ichiran Ramen Shibuya Tokyo', 'Ichiran Shibuya');
  assert.equal(m.confident, true);
  assert.equal(m.score, 1);
});

test('a partial branch-name match still counts', () => {
  const m = matchConfidence('Nabezo Shinjuku', 'Nabezo Shinjuku Sanchome');
  assert.equal(m.confident, true);
  assert.ok(m.score >= 0.5);
});

test('a different business returned for a vague query is rejected', () => {
  // The exact failure this guard exists for: Text Search answers "Ramen Tokyo"
  // with a specific shop the traveller was never told about.
  const m = matchConfidence('Ramen Tokyo', 'Ichiran Shibuya');
  assert.equal(m.confident, false);
  assert.equal(m.score, 0);
});

test('a query sharing only a neighbourhood with the result is rejected', () => {
  const m = matchConfidence('dinner in Shibuya', 'Gonpachi Shibuya');
  assert.equal(m.confident, false, 'sharing the district is not sharing the venue');
});

test('non-latin names match by containment rather than tokens', () => {
  // Japanese names carry no spaces, so token overlap would always be zero.
  const m = matchConfidence('一蘭 渋谷店', '一蘭 渋谷店');
  assert.equal(m.confident, true);
  assert.equal(m.score, 1);
});

test('an empty place name can never be confident', () => {
  assert.deepEqual(matchConfidence('Ichiran Shibuya', ''), { score: 0, confident: false });
  assert.deepEqual(matchConfidence('', 'Ichiran'), { score: 0, confident: false });
});

test('generic words in the place name do not carry a match on their own', () => {
  // "Restaurant" matching "Restaurant" must not validate two unrelated venues.
  const m = matchConfidence('Sushi Restaurant Ginza', 'Kyubey Restaurant');
  assert.equal(m.confident, false);
});
