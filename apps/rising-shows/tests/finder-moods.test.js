'use strict';

// The Finder's mood presets, and the vote floors that make their copy true.
//
// WHAT THIS PROVES
// ----------------
// A preset is one tap that replaces every filter, so whatever it hands back IS
// the answer for a visitor who never opens the advanced drawer. Until
// 2026-09-11 four of the six presets carried no vote floor at all and the
// fifth carried one that actively hurt, so "Modern prestige" opened on
// Khadpanch (1,053 votes, episode average 9.96 against an IMDb 8.4),
// "Outshines its reputation" on "Baby Geniuses Television Series" (450 votes,
// IMDb 1.3, episode average 9.89), "Kept climbing" on an 8-vote show and
// "Marathon-worthy" on a 37-vote one. The word "mood" appeared in no test file.
//
// So this file asserts the SHIPPED presets (app.js's FINDER_MOODS, reached
// through the vm harness, never a transcribed copy) through the SHIPPED
// pipeline (finder-lib's filterAndSortRows, the call the browser makes):
// every preset carries a floor, and its actual first page clears its own
// stated floors.
//
// Two halves, the same shape as tests/shows-index-parity.test.js: a synthetic
// catalogue that runs everywhere including the dependency-free push/PR CI, and
// the real catalogue, which SKIPS with a named reason when the gitignored
// release data is absent rather than passing over an empty list. Every
// assertion below is guarded by a populated-result check first: a floor test
// over zero rows is vacuously true and is exactly the bug it is meant to catch.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const Finder = require('../scripts/finder-lib.js');
const Hub = require('../scripts/render-shape-hub.js');
const { helpers } = require('./app-harness.js');

const APP_DIR = path.join(__dirname, '..');
const MOODS = helpers.FINDER_MOODS;
const moodFilters = helpers.moodFinderFilters;
const PAGE_SIZE = 24; // the Finder paginates 24 per page

// The floors a preset states about itself, in the order a reader meets them.
// Each is checked against the row field it constrains.
const FLOOR_FIELDS = [
  ['minVotes', 'votes'],
  ['minAvgEpisode', 'avgEpisode'],
  ['minSeasons', 'seasonsCount'],
  ['minEpisodes', 'episodes'],
  ['minShowRating', 'showRating'],
];

function assertPageClearsOwnFloors(mood, page, where) {
  const ff = mood.filters;
  for (const row of page) {
    for (const [filterKey, rowKey] of FLOOR_FIELDS) {
      if (!ff[filterKey]) continue;
      assert.ok(row[rowKey] >= ff[filterKey],
        `${where}: ${mood.id} page 1 row "${row.title}" has ${rowKey} ${row[rowKey]}, under its own ${filterKey} ${ff[filterKey]}`);
    }
    if (ff.gapDir === 'up') {
      assert.ok(row.gap > 0, `${where}: ${mood.id} row "${row.title}" has gap ${row.gap}, not above IMDb`);
    }
    for (const shape of (ff.shapes || [])) {
      assert.ok(row.shapes.includes(shape),
        `${where}: ${mood.id} row "${row.title}" does not carry the shape ${shape}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The presets themselves. No dataset needed.
// ---------------------------------------------------------------------------

test('the harness reaches the shipped presets', () => {
  assert.ok(Array.isArray(MOODS) && MOODS.length >= 6, 'FINDER_MOODS is exported from app.js');
  assert.equal(typeof moodFilters, 'function', 'moodFinderFilters is exported from app.js');
  const ids = MOODS.map((m) => m.id).join(',');
  assert.equal(ids, 'modern-prestige,crowd-favorites,kept-climbing,comeback-stories,marathon-worthy,outshines-reputation');
});

test('EVERY mood preset carries a vote floor', () => {
  for (const m of MOODS) {
    assert.ok(m.filters.minVotes >= Finder.RATING_SORT_VOTE_FLOOR,
      `${m.id} must floor votes at at least RATING_SORT_VOTE_FLOOR (${Finder.RATING_SORT_VOTE_FLOOR}); it has ${m.filters.minVotes || 0}`);
  }
});

// The trap that made "Modern prestige" worse than no filter at all:
// ratingSortFloorActive turns the 1,000-vote RANKING floor off the moment any
// votes filter is set, on the reasoning that a user who sets one has taken
// over. A preset sets one on the user's behalf, so a preset that sorts by a
// rating has to floor high enough to stand on its own. Setting exactly
// RATING_SORT_VOTE_FLOOR is the worst of both: the ranking floor switches off
// and the filter replacing it admits every row the ranking floor had banked.
test('a preset that sorts by a rating floors votes ABOVE the ranking floor it switches off', () => {
  for (const m of MOODS) {
    if (!Finder.RATING_SORT_KEYS.includes(m.filters.sort)) continue;
    assert.equal(Finder.ratingSortFloorActive(moodFilters(m)), false,
      `${m.id} sets minVotes, so the ranking floor is off - this is the state the floor must survive`);
    assert.ok(m.filters.minVotes > Finder.RATING_SORT_VOTE_FLOOR,
      `${m.id} sorts by ${m.filters.sort} and so turns the ${Finder.RATING_SORT_VOTE_FLOOR}-vote ranking floor off; `
      + `its own minVotes (${m.filters.minVotes}) must be strictly higher or the preset is worse off than with no filter`);
  }
});

// The gap is a difference of two ratings, so an unfloored gap ranking belongs
// to review-bombed titles. The static hub fixed this first; the preset ranks by
// the same metric and must use the same constant, not a second opinion.
test('the gap-ranked preset uses the gap hub\'s own floor', () => {
  const gapMood = MOODS.find((m) => m.filters.sort === 'gap');
  assert.ok(gapMood, 'a gap-ranked preset exists');
  assert.equal(gapMood.filters.minVotes, Finder.GAP_MIN_VOTES);
  assert.equal(Hub.GAP_MIN_VOTES, Finder.GAP_MIN_VOTES,
    'the hub and the app read ONE definition of the gap floor');
  assert.equal(Finder.GAP_MIN_VOTES, 15000, 'documented floor (README "Gap hub")');
  assert.equal(Finder.GAP_MIN_EPISODE_VOTES, Finder.GAP_MIN_VOTES, 'the two gap floors are symmetric');
});

test('moodFinderFilters produces a complete finder state and leaves the view alone', () => {
  const f = moodFilters(MOODS[0]);
  for (const k of Object.keys(Finder.FINDER_DEFAULTS)) {
    if (k === 'view') continue;
    assert.ok(k in f, `mood state carries ${k}`);
  }
  assert.equal('view' in f, false, 'a preset must not reset grid/list view');
  assert.ok(f.genres instanceof Set && f.shapes instanceof Set, 'set-valued filters are Sets');
  assert.equal(f.search, '', 'a preset clears the search box');
  assert.equal(f.page, 1, 'a preset lands on page 1');
});

// ---------------------------------------------------------------------------
// Synthetic catalogue. Runs everywhere, including dependency-free CI.
// For each preset it plants ONE row that satisfies everything the preset asks
// for EXCEPT its vote floor, and one that satisfies all of it, then asserts
// the junk row is absent and the good row is present. A preset whose results
// came back empty would pass the first half vacuously, so the good row is
// asserted first.
// ---------------------------------------------------------------------------

function row(over) {
  return {
    seriesId: over.seriesId,
    title: over.title,
    year: 2022,
    language: 'en',
    genres: ['Drama'],
    showRating: 7.0,
    votes: 1_000_000,
    episodes: 120,
    avgEpisode: 9.0,
    gap: 2.0,
    runtimeHrs: 60,
    seasonsCount: 5,
    shapes: ['rising', 'rebound'],
    ...over,
  };
}

test('synthetic: every preset admits a well-voted row and rejects the same row thinly voted', () => {
  for (const mood of MOODS) {
    const floor = mood.filters.minVotes;
    const good = row({ seriesId: 'tt-good', title: 'Well Sampled' });
    // Same row in every respect the preset filters on, one vote short.
    const junk = row({ seriesId: 'tt-junk', title: 'Brigaded', votes: floor - 1 });
    const out = Finder.filterAndSortRows([good, junk], moodFilters(mood));
    const ids = out.map((r) => r.seriesId);
    assert.ok(ids.includes('tt-good'), `${mood.id}: the well-voted row must survive (got ${ids.join(',') || 'nothing'})`);
    assert.equal(ids.includes('tt-junk'), false, `${mood.id}: a ${floor - 1}-vote row must not appear`);
    assertPageClearsOwnFloors(mood, out, 'synthetic');
  }
});

// ---------------------------------------------------------------------------
// The real catalogue. Skips loudly when the gitignored release data is absent:
// a green tick over a missing dataset is worse than a visible skip.
// ---------------------------------------------------------------------------

const SHOWS = path.join(APP_DIR, 'shows-index.json');
const haveReal = fs.existsSync(SHOWS);
const skipReason = 'release data absent (shows-index.json); run npm run fetch:rising-shows-data';

test('presets (real catalogue): every preset fills a first page that clears its own floors',
  { skip: haveReal ? false : skipReason }, () => {
    const rows = JSON.parse(fs.readFileSync(SHOWS, 'utf8')).shows;
    assert.ok(rows.length > 10000, 'sanity: this is the real catalogue');
    for (const mood of MOODS) {
      const out = Finder.filterAndSortRows(rows, moodFilters(mood));
      // POPULATED first: a floor assertion over an empty page proves nothing.
      assert.ok(out.length >= PAGE_SIZE,
        `${mood.id} must still yield at least a full page (${PAGE_SIZE}); it yields ${out.length}`);
      const page = out.slice(0, PAGE_SIZE);
      assert.equal(page.length, PAGE_SIZE, `${mood.id} page 1 is full`);
      assertPageClearsOwnFloors(mood, page, 'real');
    }
  });

// The three named regressions, pinned by name against the real catalogue. Each
// is a title the preset actually put on page 1 before 2026-09-11.
test('presets (real catalogue): the shows that used to lead these presets are gone',
  { skip: haveReal ? false : skipReason }, () => {
    const rows = JSON.parse(fs.readFileSync(SHOWS, 'utf8')).shows;
    const pageOf = (id) => {
      const mood = MOODS.find((m) => m.id === id);
      const out = Finder.filterAndSortRows(rows, moodFilters(mood));
      assert.ok(out.length >= PAGE_SIZE, `${id} yields a populated page`);
      return out.slice(0, PAGE_SIZE);
    };

    const prestige = pageOf('modern-prestige');
    assert.equal(prestige.some((r) => r.title === 'Khadpanch'), false,
      'Modern prestige led with Khadpanch: 1,053 votes, episode average 9.96 against an IMDb 8.4');
    assert.ok(Math.min(...prestige.map((r) => r.votes)) >= Finder.GAP_MIN_VOTES,
      'no row on Modern prestige page 1 is under its own floor');

    const gap = pageOf('outshines-reputation');
    assert.equal(gap.some((r) => r.title === 'Baby Geniuses Television Series'), false,
      'Outshines its reputation led with a 450-vote show rated IMDb 1.3 whose episodes average 9.89');
    assert.ok(Math.min(...gap.map((r) => r.votes)) >= Finder.GAP_MIN_VOTES,
      'no row on the gap preset page 1 is under GAP_MIN_VOTES');

    for (const id of ['kept-climbing', 'marathon-worthy', 'comeback-stories']) {
      const page = pageOf(id);
      const thinnest = Math.min(...page.map((r) => r.votes));
      assert.ok(thinnest >= Finder.RATING_SORT_VOTE_FLOOR,
        `${id} page 1 still carries a ${thinnest}-vote show; it used to open on 8, 37 and 302-vote shows`);
    }
  });

// A floor can also be set too high. A preset is a browsing surface, so it has
// to hand back at least a page; one that returns three shows is a dead chip
// carrying a count nobody wants to tap.
test('presets (real catalogue): each preset still yields a usable number of shows',
  { skip: haveReal ? false : skipReason }, () => {
    const rows = JSON.parse(fs.readFileSync(SHOWS, 'utf8')).shows;
    for (const mood of MOODS) {
      const n = Finder.filterAndSortRows(rows, moodFilters(mood)).length;
      assert.ok(n >= PAGE_SIZE && n <= rows.length,
        `${mood.id} yields ${n} shows, which is not a browsable preset`);
    }
  });
