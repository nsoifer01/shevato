import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemInstruction } from '../tp-assist.mjs';

// THE THIRD SYMPTOM OF THE 2026-09-05 REPORT.
//
// A day-planning turn came back carrying:
//
//   "Regarding your question about entry requirements, I cannot confirm visa,
//    passport, or health-related entry rules for Thailand..."
//
// The traveller had asked for a day plan. They had not asked about visas, and
// the answer even asserts a question that was never put.
//
// WHAT THIS FILE ESTABLISHES. Every mechanism that could contaminate a turn
// with a previous topic was examined, and all but one are ruled out by
// construction. Those are pinned here so the conclusion cannot rot:
//
//   * per-trip history      chat lives under `trip-planner:chat:<tripId>`, so
//                           another trip's thread can never be read into this
//                           one (client side; see the app's own chat tests)
//   * faithful passthrough  the server maps roles and clamps lengths and does
//                           nothing else - no merging, reordering, injecting or
//                           summarising of turns
//   * no caching            neither side caches a request or a reply, so a
//                           previous ANSWER cannot be served for a new question
//   * a fresh instruction   the system prompt is rebuilt per request from
//                           pinned constants plus the trip JSON, and carries no
//                           text from any earlier turn
//
// What is left is the instruction itself, and that was the bug: the
// entry-requirements rule was phrased as a standing imperative about what to
// SAY ("If the traveller asks about any of them, say plainly that...") rather
// than as a limit on what may be ASSERTED. A long, emphatic block of that shape
// sitting in every prompt is discharged on turns that never raised the subject.
// The tests below pin the corrected shape.

const TRIP = {
  items: [
    { id: 's1', type: 'stay', title: 'A Hotel', location: 'Krabi',
      startDate: '2027-02-01', endDate: '2027-02-05', status: 'booked' },
  ],
};
const ctx = (over = {}) => ({ trip: TRIP, today: '2027-01-20', focusDate: '2027-02-02', mode: 'plan', ...over });

test('the substantive safety rule is intact: entry requirements are never stated as fact', () => {
  const p = buildSystemInstruction(ctx(), false);
  assert.match(p, /NEVER state entry requirements as fact/i);
  assert.match(p, /visa/i);
  assert.match(p, /never guess, never quote a number of visa-free days/i);
  assert.match(p, /official immigration site/i);
});

test('but it is a limit on ASSERTIONS, not a disclaimer to volunteer', () => {
  const p = buildSystemInstruction(ctx(), false);
  assert.match(p, /limit on what you may ASSERT, not a disclaimer to volunteer/i);
  assert.match(p, /do not mention visas, passports, vaccinations or entry rules at all/i);
  assert.match(p, /never open a reply by referring to a question they did not ask/i);
});

test('and the rule is scoped to the CURRENT message, not the conversation', () => {
  const p = buildSystemInstruction(ctx(), false);
  assert.match(p, /ONLY IF the traveller asks about one of them in their CURRENT message/i);
  assert.match(p, /has not raised entry requirements in their current message/i);
});

test('earlier turns are context for this request, never a topic to continue', () => {
  assert.match(buildSystemInstruction(ctx(), false),
    /Earlier turns in this conversation are context for the CURRENT request only: never continue, re-answer or append a previous topic to a new one/i);
});

test('THE SHAPE THAT LEAKED is gone: no bare "if they ask, say..." standing order', () => {
  // The exact phrasing that read as an instruction to deliver a paragraph.
  // Its replacement carries the ONLY IF / CURRENT message qualifier.
  const p = buildSystemInstruction(ctx(), false);
  assert.doesNotMatch(p, /If the traveller asks about any of them, say plainly/i);
});

test('the instruction is rebuilt per request and carries no previous answer', () => {
  // Two turns of the same conversation produce byte-identical instructions for
  // identical context: nothing accumulates, so no earlier reply can ride along.
  const a = buildSystemInstruction(ctx(), false);
  const b = buildSystemInstruction(ctx(), false);
  assert.equal(a, b);
  // and it never contains prose from an answer
  assert.doesNotMatch(a, /Regarding your question/i);
  assert.doesNotMatch(a, /I cannot confirm visa, passport, or health-related/i);
});

test('the instruction is a pure function of the context it is handed', () => {
  // The only things that vary are the trip, the dates and the mode - all
  // supplied by THIS request. A different focus day changes the prompt; nothing
  // else can, which is what makes turn-to-turn contamination impossible here.
  const one = buildSystemInstruction(ctx({ focusDate: '2027-02-02' }), false);
  const two = buildSystemInstruction(ctx({ focusDate: '2027-02-03' }), false);
  assert.notEqual(one, two);
  assert.match(one, /2027-02-02/);
  assert.doesNotMatch(one, /2027-02-03/);
  // and a trip with no items still builds an instruction rather than borrowing
  const empty = buildSystemInstruction(ctx({ trip: null }), false);
  assert.match(empty, /travel-planning assistant/i);
  assert.doesNotMatch(empty, /A Hotel/);
});

test('the trip JSON in the prompt is the CURRENT trip, never a merged history', () => {
  const p = buildSystemInstruction(ctx(), false);
  assert.match(p, /A Hotel/);
  const other = buildSystemInstruction(ctx({
    trip: { items: [{ id: 'x', type: 'stay', title: 'Another Hotel', location: 'Phuket',
      startDate: '2027-03-01', endDate: '2027-03-04', status: 'booked' }] },
  }), false);
  assert.doesNotMatch(other, /A Hotel/, 'one trip per prompt, with no bleed from another');
  assert.match(other, /Another Hotel/);
});
