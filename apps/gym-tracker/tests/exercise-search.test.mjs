// Exercise search: matching and ranking (GT-24, GT-25, GT-26).
//
// The old search was `name.includes(term) || muscleGroup.includes(term)`.
// Against the real 514-exercise catalog that produced:
//
//   "pull up"          -> 0 results   (the catalog spells it "Pull-Ups")
//   "pullup"           -> 0 results
//   "triceps pushdown" -> 0 results   ("Cable Rope Pushdown", category triceps)
//   "row"              -> "Nar-ROW- Chest Press Machine" first
//   "plank"            -> the exercise called "Plank" fifth
//   "Barbell Curl"     -> the exact match second
//
// These run against the REAL catalog, not a fixture, because the ranking
// claims are claims about that catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    matchesQuery,
    normalizeSearchText,
    scoreExercise,
    searchExercises,
    tokenize,
} from '../js/utils/exercise-search.js';
import {
    CATEGORY_VALUES,
    CUSTOM_EXERCISE_NAME_MAX,
    EQUIPMENT_VALUES,
    EXERCISE_CATEGORIES,
    EXERCISE_EQUIPMENT,
    categoryLabel,
    equipmentLabel,
} from '../js/utils/exercise-taxonomy.js';

const CATALOG = JSON.parse(
    readFileSync(new URL('../data/exercises-db.json', import.meta.url), 'utf8'),
);

const names = (query, n = 5) => searchExercises(CATALOG, query).slice(0, n).map(e => e.name);

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('normalisation folds case, hyphens, spaces and punctuation', () => {
    assert.equal(normalizeSearchText('Pull-Ups'), 'pull ups');
    assert.equal(normalizeSearchText("Farmer's Carry"), 'farmers carry');
    assert.equal(normalizeSearchText('  Cable   Rope  '), 'cable rope');
});

test('tokenising drops a trailing plural so ups/up are the same word', () => {
    assert.deepEqual(tokenize('Pull-Ups'), ['pull', 'up']);
    assert.deepEqual(tokenize('pull up'), ['pull', 'up']);
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('Bench Press'), ['bench', 'press'], '"press" is not a plural');
});

// ---------------------------------------------------------------------------
// The audit's queries
// ---------------------------------------------------------------------------

test('"pull up" finds pull-ups, and ranks the plain one first', () => {
    const out = names('pull up');
    assert.ok(out.length > 0, 'a 514-exercise catalog must not answer this with nothing');
    assert.equal(out[0], 'Pull-Ups');
});

test('"pullup" (no separator at all) finds them too', () => {
    const out = names('pullup');
    assert.equal(out[0], 'Pull-Ups');
});

test('"pull-up" keeps working', () => {
    assert.equal(names('pull-up')[0], 'Pull-Ups');
});

test('"row" ranks real rows above "Nar-row- Chest Press Machine"', () => {
    const out = searchExercises(CATALOG, 'row').map(e => e.name);
    assert.match(out[0], /Row/, `expected a row first, got ${out[0]}`);
    const narrow = out.indexOf('Narrow Chest Press Machine');
    assert.ok(narrow > 5, `an accidental substring must not rank near the top (was ${narrow})`);
});

test('"plank" puts the exercise actually called Plank first', () => {
    assert.equal(names('plank')[0], 'Plank');
});

test('"Barbell Curl" puts the exact match first, ahead of "21s Barbell Curl"', () => {
    const out = names('Barbell Curl');
    assert.equal(out[0], 'Barbell Curl');
    assert.ok(out.includes('21s Barbell Curl'), 'the variant is still findable');
});

test('"triceps pushdown" combines a name word with a category word', () => {
    // No exercise is literally called that; the query is satisfied by
    // "pushdown" in the name plus "triceps" in the category.
    const out = searchExercises(CATALOG, 'Triceps Pushdown');
    assert.ok(out.length > 0, 'this is how people type it');
    assert.ok(out.every(e => /pushdown/i.test(e.name)), 'every result really is a pushdown');
    assert.ok(out.every(e => e.category === 'triceps' || /triceps/i.test(e.muscleGroup || '')));
});

test('"bench press" and "benchpress" agree', () => {
    assert.deepEqual(names('bench press'), names('benchpress'));
});

// ---------------------------------------------------------------------------
// Ranking rules
// ---------------------------------------------------------------------------

test('an exact name outscores a name that merely contains the words', () => {
    const exact = CATALOG.find(e => e.name === 'Plank');
    const other = CATALOG.find(e => e.name === 'Side Plank');
    assert.ok(scoreExercise(exact, 'plank') > scoreExercise(other, 'plank'));
});

test('a whole-word match outscores a mid-word substring by a wide margin', () => {
    const realRow = CATALOG.find(e => e.name === 'Barbell Row');
    const narrow = CATALOG.find(e => e.name === 'Narrow Chest Press Machine');
    assert.ok(scoreExercise(realRow, 'row') > scoreExercise(narrow, 'row') * 5);
});

test('EVERY query term has to match something', () => {
    const bench = CATALOG.find(e => e.name === 'Barbell Bench Press');
    assert.equal(matchesQuery(bench, 'barbell bench'), true);
    assert.equal(matchesQuery(bench, 'barbell bench kayak'), false, 'one bad term rules it out');
});

test('an empty query matches everything and preserves the caller\'s order', () => {
    const list = [{ name: 'Zebra' }, { name: 'Apple' }];
    assert.deepEqual(searchExercises(list, '').map(e => e.name), ['Zebra', 'Apple']);
    assert.deepEqual(searchExercises(list, '   ').map(e => e.name), ['Zebra', 'Apple']);
});

test('ties break alphabetically, so results are stable between renders', () => {
    const out = names('dumbbell', 40);
    const scores = searchExercises(CATALOG, 'dumbbell').slice(0, 40)
        .map(e => scoreExercise(e, 'dumbbell'));
    for (let i = 1; i < out.length; i++) {
        if (scores[i] === scores[i - 1]) {
            assert.ok(out[i - 1].localeCompare(out[i]) <= 0, `${out[i - 1]} should precede ${out[i]}`);
        }
    }
});

test('search never throws on a junk exercise record', () => {
    assert.equal(scoreExercise(null, 'row'), 0);
    assert.equal(scoreExercise({}, 'row'), 0);
    assert.equal(scoreExercise({ name: '' }, 'row'), 0);
});

// ---------------------------------------------------------------------------
// GT-26: one taxonomy, shared by the browse filter and the create form
// ---------------------------------------------------------------------------

test('the taxonomy covers every category the real catalog uses', () => {
    const used = new Set(CATALOG.map(e => e.category));
    const known = new Set(CATEGORY_VALUES);
    const missing = [...used].filter(c => !known.has(c));
    assert.deepEqual(missing, [], 'a catalog category with no taxonomy entry is unfilterable');
});

test('the taxonomy covers every equipment value the real catalog uses', () => {
    const used = new Set(CATALOG.map(e => e.equipment));
    const known = new Set(EQUIPMENT_VALUES);
    assert.deepEqual([...used].filter(c => !known.has(c)), []);
});

test('the seven categories a custom exercise could not be filed under are present', () => {
    // The exact gap the audit measured: browse offered 17, the create form 10.
    ['forearms', 'glutes', 'abs', 'obliques', 'traps', 'neck', 'cardio']
        .forEach(c => assert.ok(CATEGORY_VALUES.includes(c), `${c} is missing`));
    assert.equal(EXERCISE_CATEGORIES.length, 17);
});

test('every taxonomy entry has a human label', () => {
    EXERCISE_CATEGORIES.forEach(({ value, label }) => {
        assert.ok(label && label !== value.toUpperCase(), `${value} needs a label`);
        assert.equal(categoryLabel(value), label);
    });
    EXERCISE_EQUIPMENT.forEach(({ value, label }) => assert.equal(equipmentLabel(value), label));
});

test('an unknown value still gets a readable label rather than a raw slug', () => {
    assert.equal(categoryLabel('lower-back'), 'Lower Back');
    assert.equal(equipmentLabel('smith-machine'), 'Smith Machine');
});

test('the custom-exercise name cap is a sane, stated number', () => {
    assert.equal(typeof CUSTOM_EXERCISE_NAME_MAX, 'number');
    const longest = Math.max(...CATALOG.map(e => e.name.length));
    assert.ok(CUSTOM_EXERCISE_NAME_MAX >= longest,
        `the cap (${CUSTOM_EXERCISE_NAME_MAX}) must not be shorter than the catalog's own longest name (${longest})`);
    assert.ok(CUSTOM_EXERCISE_NAME_MAX < 120, 'and shorter than the 120-char name the audit got in');
});

// Every surface that offers a category or equipment choice must fill it from
// the taxonomy module. The audit's finding was four hand-written copies of the
// same lists in index.html, three of which had already drifted; if a view stops
// calling populateSelect the drift comes straight back.
test('all four exercise-choice surfaces populate from the shared taxonomy', () => {
    const surfaces = [
        { file: '../js/views/exercises-view.js', selects: ['exercise-db-category', 'exercise-db-equipment',
            'custom-exercise-category', 'custom-exercise-muscle', 'custom-exercise-equipment'] },
        { file: '../js/views/programs-view.js', selects: ['exercise-category-filter', 'exercise-equipment-filter'] },
        { file: '../js/views/workout-view.js', selects: ['swap-exercise-category-filter', 'swap-exercise-equipment-filter'] },
    ];
    for (const { file, selects } of surfaces) {
        const src = readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.match(src, /from '\.\.\/utils\/exercise-taxonomy\.js'/,
            `${file} must import the taxonomy rather than trusting the markup`);
        assert.ok(/populateSelect\(/.test(src), `${file} must call populateSelect`);
        for (const id of selects) {
            assert.ok(src.includes(id), `${file} lost its reference to #${id}`);
        }
    }
});
