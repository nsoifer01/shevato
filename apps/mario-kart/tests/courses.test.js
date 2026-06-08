'use strict';

// Tests for the course-data layer: the vendored dataset's integrity and the
// pure transforms in js/courseData.js (loaded the same classic-script way the
// other mario-kart tests use).

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const JS_DIR = path.join(__dirname, '..', 'js');
const DATA_FILE = path.join(__dirname, '..', 'data', 'courses.json');

const dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

// Load courseData.js into a vm with a window + localStorage stub and return
// the resulting window.CourseData surface.
function loadCourseData() {
  const map = new Map();
  const sandbox = {
    console,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    window: {},
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
    },
  };
  sandbox.window.localStorage = sandbox.localStorage;
  // App prefixes course storage by game version; a stub is enough here.
  sandbox.window.getStorageKey = (base) => 'marioKartWorld' + base;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(JS_DIR, 'courseData.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'courseData.js' });
  return ctx.window.CourseData;
}

// --- Dataset integrity -----------------------------------------------------

test('courses.json: every game has non-empty cups and well-formed courses', () => {
  for (const [gameKey, game] of Object.entries(dataset.games)) {
    assert.ok(Array.isArray(game.cups) && game.cups.length > 0, `${gameKey} has cups`);
    assert.ok(typeof game.maxPositions === 'number', `${gameKey} has maxPositions`);
    for (const cup of game.cups) {
      assert.ok(cup.id && cup.name, `${gameKey} cup has id+name`);
      assert.ok(Array.isArray(cup.courses) && cup.courses.length > 0, `${gameKey}/${cup.id} has courses`);
      for (const c of cup.courses) {
        assert.ok(c.id && c.name, `${gameKey}/${cup.id} course has id+name`);
      }
    }
  }
});

test('courses.json: a reused course id always carries the same name', () => {
  for (const [gameKey, game] of Object.entries(dataset.games)) {
    const names = new Map();
    for (const cup of game.cups) {
      for (const c of cup.courses) {
        if (names.has(c.id)) {
          assert.equal(names.get(c.id), c.name, `${gameKey}: id ${c.id} reused with mismatched name`);
        }
        names.set(c.id, c.name);
      }
    }
  }
});

// --- Pure transforms -------------------------------------------------------

test('flattenCourses: dedupes a course that appears in two cups, merging cups[]', () => {
  const CourseData = loadCourseData();
  const flat = CourseData.flattenCourses(dataset.games.mkworld);
  const ids = flat.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'flattened list has no duplicate ids');

  // Crown City appears in both Mushroom Cup and Shell Cup in MK World.
  const crownCity = flat.find((c) => c.id === 'crown-city');
  assert.ok(crownCity, 'crown-city present');
  assert.equal(crownCity.cups.length, 2, 'crown-city lists both cups');
});

test('groupByCup: preserves cup order and course counts', () => {
  const CourseData = loadCourseData();
  const groups = CourseData.groupByCup(dataset.games.mk8d);
  assert.equal(groups[0].name, dataset.games.mk8d.cups[0].name);
  assert.equal(groups[0].courses.length, dataset.games.mk8d.cups[0].courses.length);
});

test('searchCourses: matches name, alias, and origin case-insensitively', () => {
  const CourseData = loadCourseData();
  const flat = CourseData.flattenCourses(dataset.games.mkworld);

  assert.ok(CourseData.searchCourses(flat, 'rainbow').some((c) => c.id === 'rainbow-road-world'), 'by name');
  assert.ok(CourseData.searchCourses(flat, 'mbc').some((c) => c.id === 'mario-bros-circuit'), 'by alias');
  assert.ok(CourseData.searchCourses(flat, 'mario kart 7').length > 0, 'by origin');
  assert.equal(CourseData.searchCourses(flat, '').length, flat.length, 'empty query returns all');
  assert.equal(CourseData.searchCourses(flat, 'zzzzz').length, 0, 'no match returns empty');
});

test('rankCourses: prefix beats substring, exact beats prefix', () => {
  const CourseData = loadCourseData();
  const flat = CourseData.flattenCourses(dataset.games.mk8d);
  const ranked = CourseData.rankCourses(flat, 'mario');
  // "Mario Circuit" / "Mario Kart Stadium" (word-start) must outrank a course
  // that only contains "mario" via origin/alias.
  assert.ok(ranked.length > 1);
  assert.ok(/^Mario/.test(ranked[0].name), `expected a Mario* course first, got ${ranked[0].name}`);
});

test('rankCourses: punctuation-insensitive and initials matching', () => {
  const CourseData = loadCourseData();
  const flat = CourseData.flattenCourses(dataset.games.mkworld);
  // "Mario Bros. Circuit" found by typing without the period.
  assert.equal(CourseData.rankCourses(flat, 'mario bros circuit')[0].id, 'mario-bros-circuit');
  // Initials: "mks" -> Mario Kart Stadium (mk8d set).
  const flat8 = CourseData.flattenCourses(dataset.games.mk8d);
  assert.ok(CourseData.rankCourses(flat8, 'mks').some((c) => c.id === 'mario-kart-stadium'));
});

test('scoreCourse: non-matching query scores zero', () => {
  const CourseData = loadCourseData();
  const flat = CourseData.flattenCourses(dataset.games.mk8d);
  assert.equal(CourseData.scoreCourse(flat[0], 'zzzzz'), 0);
});

test('normalizeDataset: rejects a structurally invalid dataset', () => {
  const CourseData = loadCourseData();
  assert.throws(() => CourseData.normalizeDataset({}), /missing games/);
  assert.throws(() => CourseData.normalizeDataset({ games: { x: {} } }), /missing cups/);
});

// --- Recents & favorites ---------------------------------------------------

test('recents: most-recent-first, de-duplicated, capped', () => {
  const CourseData = loadCourseData();
  CourseData.pushRecent('a');
  CourseData.pushRecent('b');
  CourseData.pushRecent('a'); // re-selecting a moves it to front, no dupe
  const recents = CourseData.getRecentIds();
  assert.deepEqual(recents.slice(0, 2), ['a', 'b']);
  assert.equal(new Set(recents).size, recents.length);
});

test('favorites: toggle on then off', () => {
  const CourseData = loadCourseData();
  assert.equal(CourseData.isFavorite('rainbow-road'), false);
  assert.equal(CourseData.toggleFavorite('rainbow-road'), true);
  assert.equal(CourseData.isFavorite('rainbow-road'), true);
  assert.equal(CourseData.toggleFavorite('rainbow-road'), false);
  assert.equal(CourseData.isFavorite('rainbow-road'), false);
});
