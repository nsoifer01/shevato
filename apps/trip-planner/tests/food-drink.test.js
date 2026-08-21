'use strict';

// Food & Drink as STRUCTURED data (trip-logic.js): the `meal` vocabulary, the
// legacy-title migration, and every surface that had been reading a category
// out of free-form title text.
//
// The round this pins: "Dinner: Saba" was an `activity` whose CATEGORY lived
// in a title prefix the traveller had to type, which duplicated the icon,
// fought the venue autocomplete (every keystroke of "Dinner: " re-queried the
// place provider with a string no venue is named) and made Activity mean both
// "museum" and "restaurant". It is now type Food & Drink + category Dinner +
// title "Saba".
//
// The two invariants worth stating out loud, because both are load-bearing:
//
//   1. STORAGE STAYS `activity` + `meal`. A seventh storage TYPE would be
//      coerced to 'note' by every already-deployed repairDb (and sync is
//      whole-db last-writer-wins), so one stale tab would silently destroy
//      the category AND the type. An unknown FIELD rides through untouched.
//      'food' therefore exists only in the form and in display groupings.
//
//   2. The migration is DETERMINISTIC and narrow: only the four literal
//      assistant-contract prefixes, colon required. A title that merely
//      mentions a meal ("Sunset dinner cruise", "Dinnerware shopping") is
//      never rewritten - that text is the traveller's.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/trip-logic.js');

const act = (over = {}) => ({
  id: 'a1', type: 'activity', title: 'Saba', location: 'New Orleans',
  startDate: '2027-05-04', startTime: '19:00', status: 'to-book', ...over,
});

// ---------------------------------------------------------------------------
// The vocabulary
test('the meal vocabulary is the smallest sensible set, and every key has a label', () => {
  assert.deepEqual(Object.keys(L.MEAL_META),
    ['breakfast', 'brunch', 'lunch', 'dinner', 'drinks', 'cafe', 'snack', 'other']);
  for (const k of Object.keys(L.MEAL_META)) {
    assert.equal(typeof L.mealLabel(k), 'string');
    assert.ok(L.mealLabel(k).length, `${k} has no label`);
    assert.equal(L.isMealKind(k), true);
  }
});

test('isMealKind reads OWN properties, so a hand-edited import cannot smuggle one in', () => {
  // the __proto__ trap that bit the quota counters: `in` and a bare lookup
  // both answer true for inherited keys, and 'constructor' is a function
  for (const junk of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'Dinner', 'DINNER', '', null, undefined, 7, {}]) {
    assert.equal(L.isMealKind(junk), false, `${String(junk)} must not be a meal kind`);
    assert.equal(L.mealLabel(junk), '', `${String(junk)} must have no label`);
  }
});

// ---------------------------------------------------------------------------
// Reading an item
test('itemMealKind prefers the structured field over anything in the title', () => {
  assert.equal(L.itemMealKind(act({ meal: 'dinner' })), 'dinner');
  assert.equal(L.itemMealKind(act({ meal: 'drinks', title: 'Hot Tin' })), 'drinks');
  // the field wins even when the title says something else: the field is the
  // one a control wrote, the title is just words
  assert.equal(L.itemMealKind(act({ meal: 'breakfast', title: 'Dinner: Saba' })), 'breakfast');
});

test('itemMealKind falls back to a legacy prefix, for data repair never reached', () => {
  // a read-only shared trip is rendered without ever passing through repairDb
  assert.equal(L.itemMealKind(act({ title: 'Dinner: Saba' })), 'dinner');
  assert.equal(L.itemMealKind(act({ title: 'Drinks: Hot Tin' })), 'drinks');
  assert.equal(L.itemMealKind(act({ title: 'Breakfast: Bricolage' })), 'breakfast');
  assert.equal(L.itemMealKind(act({ title: 'Lunch: Ichiran' })), 'lunch');
});

test('Activity stays independent: a museum is not food, whatever its name says', () => {
  assert.equal(L.itemMealKind(act({ title: 'The National WWII Museum' })), '');
  assert.equal(L.itemMealKind(act({ title: 'Sunset dinner cruise' })), '');
  assert.equal(L.itemMealKind(act({ title: 'Dinnerware shopping' })), '');
  assert.equal(L.itemMealKind(act({ title: 'Drinks with Ana at the hotel' })), '');
});

test('only an activity can be food & drink', () => {
  for (const type of ['flight', 'stay', 'transport', 'local', 'note']) {
    assert.equal(L.itemMealKind({ type, title: 'Dinner: Saba', meal: 'dinner' }), '',
      `${type} must never read as food & drink`);
  }
  assert.equal(L.itemMealKind(null), '');
  assert.equal(L.itemMealKind(undefined), '');
});

// ---------------------------------------------------------------------------
// The legacy split
test('splitMealTitle separates the category from the venue name', () => {
  assert.deepEqual(L.splitMealTitle('Dinner: Saba'), { meal: 'dinner', title: 'Saba' });
  assert.deepEqual(L.splitMealTitle('Drinks: Hot Tin'), { meal: 'drinks', title: 'Hot Tin' });
  assert.deepEqual(L.splitMealTitle('Drinks: Cure'), { meal: 'drinks', title: 'Cure' });
  assert.deepEqual(L.splitMealTitle('Breakfast: Cafe Du Monde'), { meal: 'breakfast', title: 'Cafe Du Monde' });
  // the matching rule isFoodOrDrink already documented: case-insensitive,
  // leading space ignored, the space after the colon optional
  assert.deepEqual(L.splitMealTitle('  dinner:Narisawa'), { meal: 'dinner', title: 'Narisawa' });
});

test('splitMealTitle refuses anything that is not one of the four contract prefixes', () => {
  for (const t of ['Sunset dinner cruise', 'Dinnerware shopping', 'The National WWII Museum',
    'Brunch: Elizabeths', 'Cafe: Du Monde', 'Snack: beignets', '', null, undefined]) {
    assert.equal(L.splitMealTitle(t), null, `${String(t)} must not split`);
  }
});

test('a title that is nothing BUT the prefix keeps a usable name', () => {
  // '' would fail validateItem and destroy the row on the next save
  assert.deepEqual(L.splitMealTitle('Dinner:'), { meal: 'dinner', title: 'Dinner' });
  assert.deepEqual(L.splitMealTitle('Drinks: '), { meal: 'drinks', title: 'Drinks' });
});

// ---------------------------------------------------------------------------
// The normalizer every entry path shares
test('normalizeMealItem migrates a legacy prefixed activity in place', () => {
  const it = act({ title: 'Dinner: Saba' });
  L.normalizeMealItem(it);
  assert.equal(it.meal, 'dinner');
  assert.equal(it.title, 'Saba');
  assert.equal(it.type, 'activity', 'storage type must not change');
});

test('normalizeMealItem leaves an already-structured item completely alone', () => {
  // the title is the venue's and is never re-parsed once the field exists
  const it = act({ meal: 'drinks', title: 'Dinner Club' });
  const before = JSON.stringify(it);
  L.normalizeMealItem(it);
  assert.equal(JSON.stringify(it), before);
});

test('normalizeMealItem never rewrites an ordinary activity title', () => {
  for (const title of ['Sunset dinner cruise', 'The National WWII Museum', 'Dinnerware shopping']) {
    const it = act({ title });
    L.normalizeMealItem(it);
    assert.equal(it.title, title);
    assert.equal('meal' in it, false, `${title} must not gain a meal`);
  }
});

test('normalizeMealItem drops a meal that is junk or sits on the wrong type', () => {
  const junk = act({ meal: 'brinner' });
  L.normalizeMealItem(junk);
  assert.equal('meal' in junk, false);

  const wrongType = { type: 'stay', title: 'Hotel Peter and Paul', meal: 'dinner' };
  L.normalizeMealItem(wrongType);
  assert.equal('meal' in wrongType, false);

  const proto = act({ meal: '__proto__' });
  L.normalizeMealItem(proto);
  assert.equal('meal' in proto, false);
});

test('normalizeMealItem is idempotent: running it twice changes nothing', () => {
  const it = act({ title: 'Drinks: Hot Tin' });
  L.normalizeMealItem(it);
  const once = JSON.stringify(it);
  L.normalizeMealItem(it);
  assert.equal(JSON.stringify(it), once);
});

// ---------------------------------------------------------------------------
// Surfaces that used to read the title
test('costsByType splits food & drink out of activities', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'a', type: 'activity', title: 'Saba', meal: 'dinner', status: 'booked', cost: 90, costCurrency: 'USD', startDate: '2027-05-04' },
    { id: 'b', type: 'activity', title: 'Hot Tin', meal: 'drinks', status: 'booked', cost: 30, costCurrency: 'USD', startDate: '2027-05-04' },
    { id: 'c', type: 'activity', title: 'The National WWII Museum', status: 'booked', cost: 32, costCurrency: 'USD', startDate: '2027-05-05' },
    // legacy, not yet repaired: still counted as food
    { id: 'd', type: 'activity', title: 'Lunch: Cochon', status: 'booked', cost: 45, costCurrency: 'USD', startDate: '2027-05-05' },
  ] };
  const rows = L.costsByType(trip, null);
  const byType = Object.fromEntries(rows.map(r => [r.type, r.total]));
  assert.equal(byType.food, 165);
  assert.equal(byType.activity, 32);
  assert.equal(rows.length, 2);
});

test('the day-copy text uses the category ICON, never a category word', () => {
  const items = [
    { id: 'a', type: 'activity', title: 'Saba', meal: 'dinner', startDate: '2027-05-04', startTime: '19:00', status: 'to-book' },
    { id: 'b', type: 'activity', title: 'Hot Tin', meal: 'drinks', startDate: '2027-05-04', startTime: '21:00', status: 'to-book' },
    { id: 'c', type: 'activity', title: 'The National WWII Museum', startDate: '2027-05-04', startTime: '10:00', status: 'to-book' },
  ];
  const card = L.dayCards({ items })[0];
  const text = L.dayShareText(card, items, d => d, t => t);
  assert.ok(text.includes('🍽️ Saba'), text);
  assert.ok(text.includes('🍸 Hot Tin'), text);
  assert.ok(text.includes('🎟️ The National WWII Museum'), text);
  assert.ok(!/Dinner:/.test(text), 'the pasted day must not repeat the category in words');
  assert.ok(!/Drinks:/.test(text), text);
});

test('the CALENDAR keeps the category in words: an .ics event has no icon', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'a', type: 'activity', title: 'Saba', meal: 'dinner', startDate: '2027-05-04', startTime: '19:00', status: 'booked' },
    { id: 'b', type: 'activity', title: 'The National WWII Museum', startDate: '2027-05-05', startTime: '10:00', status: 'booked' },
  ] };
  const ics = L.buildIcs(trip);
  assert.ok(ics.includes('SUMMARY:Dinner: Saba'), ics);
  assert.ok(ics.includes('SUMMARY:The National WWII Museum'), ics);
});

test('a share link carries the category, so the far side is not left guessing', () => {
  const trip = { name: 'T', currency: 'USD', items: [
    { id: 'a', type: 'activity', title: 'Saba', meal: 'dinner', startDate: '2027-05-04', startTime: '19:00', status: 'to-book' },
  ] };
  const slim = L.slimTripForShare(trip);
  assert.equal(slim.items[0].meal, 'dinner');
  assert.equal(slim.items[0].title, 'Saba');
});

test('the recommendation window reads the structured field, and knows the new kinds', () => {
  // meals 30, drinks 45, cafe/snack 30 - the same numbers, now reachable
  // without a prefix in the title
  assert.equal(L.recommendWindowMin(act({ meal: 'dinner', title: 'Saba' })), 30);
  assert.equal(L.recommendWindowMin(act({ meal: 'brunch', title: 'Elizabeths' })), 30);
  assert.equal(L.recommendWindowMin(act({ meal: 'drinks', title: 'Hot Tin' })), 45);
  assert.equal(L.recommendWindowMin(act({ meal: 'cafe', title: 'Cafe Du Monde' })), 30);
  assert.equal(L.recommendWindowMin(act({ meal: 'snack', title: 'Angelo Brocato' })), 30);
  // and the legacy prefix still resolves for un-repaired data
  assert.equal(L.recommendWindowMin(act({ title: 'Dinner: Narisawa' })), 30);
  // an ordinary activity is untouched
  assert.equal(L.recommendWindowMin(act({ title: 'Louvre' })), 45);
});

test('itemMapsQuery searches the VENUE NAME, with no prefix to strip', () => {
  // the autocomplete/place-lookup payoff: the query is what the traveller
  // typed, so nothing has to interpret an app convention before searching
  assert.equal(L.itemMapsQuery(act({ meal: 'dinner', title: 'Saba', location: 'New Orleans' })),
    'Saba New Orleans');
  assert.equal(L.itemMapsQuery(act({ meal: 'drinks', title: 'Hot Tin', location: 'New Orleans' })),
    'Hot Tin New Orleans');
  // and a legacy row still resolves to the same string it always did
  assert.equal(L.itemMapsQuery(act({ title: 'Dinner: Saba', location: 'New Orleans' })),
    'Saba New Orleans');
});

// ---------------------------------------------------------------------------
// Example trips
test('every example trip builds structured food & drink and bare venue titles', () => {
  let meals = 0;
  for (const opt of L.sampleTripOptions()) {
    const trip = L.buildSampleTrip(opt.id, { today: '2027-05-01' });
    for (const it of trip.items) {
      assert.ok(!L.mealKind(it.title), `${opt.id}: "${it.title}" still carries a prefix`);
      const kind = L.itemMealKind(it);
      if (kind) {
        meals++;
        assert.equal(it.type, 'activity', `${opt.id}: ${it.title} must still store as an activity`);
        assert.equal(L.isMealKind(it.meal), true, `${opt.id}: ${it.title} has no structured meal`);
      }
    }
  }
  // the library is the app's shop window: it has to demonstrate the feature
  assert.ok(meals > 100, `only ${meals} structured meals across the library`);
});

// ---------------------------------------------------------------------------
// Every supported subtype, end to end through the pure surfaces
test('EVERY subtype survives storage, display, export and the share payload', () => {
  // The form writes one of these eight and nothing else (app.js clamps an
  // unknown value to 'other' on save), so each one is walked through the
  // surfaces that have to understand it. A kind added to MEAL_META without a
  // label, a window or a share slot fails here rather than in the UI.
  const kinds = Object.keys(L.MEAL_META);
  assert.equal(kinds.length, 8);
  for (const kind of kinds) {
    const it = act({ meal: kind, title: 'Venue ' + kind });
    // reads back as itself, on an activity and nowhere else
    assert.equal(L.itemMealKind(it), kind, kind);
    assert.ok(L.mealLabel(kind).length, `${kind} has no label`);
    // survives the repair normalizer untouched (title never re-parsed)
    const copy = { ...it };
    L.normalizeMealItem(copy);
    assert.equal(copy.meal, kind, kind);
    assert.equal(copy.title, 'Venue ' + kind, kind);
    // has a recommendation window (drinks 45, cafe/snack 30, meals 30,
    // 'other' falls to the unclassified default rather than inventing one)
    const win = L.recommendWindowMin(it);
    assert.ok(Number.isInteger(win) && win > 0, `${kind} has no window: ${win}`);
    // rides a share link, and the calendar spells it out
    const trip = { name: 'T', currency: 'USD', items: [{ ...it, status: 'booked' }] };
    assert.equal(L.slimTripForShare(trip).items[0].meal, kind, kind);
    assert.ok(L.buildIcs(trip).includes(`SUMMARY:${L.mealLabel(kind)}: Venue ${kind}`), kind);
    // and lands in the food row of the cost breakdown, never in activity
    const costed = { name: 'T', currency: 'USD', items: [{ ...it, status: 'booked', cost: 10, costCurrency: 'USD' }] };
    assert.deepEqual(L.costsByType(costed, null).map(r => r.type), ['food'], kind);
  }
});

test('the four kinds the assistant can produce are a SUBSET of the form vocabulary', () => {
  // the contract writes Breakfast/Lunch/Dinner/Drinks; the form adds four more
  const fromContract = L.mealTitlePrefixes().map(p => p.trim().replace(/:$/, '').toLowerCase());
  assert.deepEqual(fromContract, ['breakfast', 'lunch', 'dinner', 'drinks']);
  for (const k of fromContract) assert.equal(L.isMealKind(k), true, `${k} is not in MEAL_META`);
});

test('the assistant contract is UNCHANGED: the prompt still asks for prefixes', () => {
  // The model writes "Dinner: Narisawa" on the wire and the accept path
  // converts at the boundary (app.js proposalToItem -> normalizeMealItem).
  // Changing the contract is a separate decision from changing storage, and
  // this test is what stops one drifting into the other by accident.
  assert.deepEqual(L.mealTitlePrefixes(), ['Breakfast: ', 'Lunch: ', 'Dinner: ', 'Drinks: ']);
  const prompt = L.buildAssistSystemPrompt({ trip: { name: 'T', items: [] } });
  assert.ok(/"Dinner: "/.test(prompt), 'the prompt no longer states the prefix contract');
});
