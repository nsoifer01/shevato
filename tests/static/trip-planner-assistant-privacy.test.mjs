// privacy.html is binding: it makes narrow, checkable promises about what each
// app sends. Two of those promises are about the Trip Planner assistant, and
// both had drifted from the code by the time the 2026-08-22 audit found them
// (AS-01, AS-B3):
//
//   - the page said the default mode was copy-and-paste, "which sends nothing
//     anywhere", while the app had defaulted to the free shared assistant since
//     the 2026-08-19 QA round decided a first-time traveller should land on the
//     one-click tier;
//   - it listed what is sent without saying what is deliberately held back.
//
// Prose cannot be diffed against behaviour automatically, but these two facts
// can: the default tier is one literal in app.js, and the fields kept out of
// the assistant projection are one list in trip-logic.js. If either moves, this
// fails and the page has to move with it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(REPO, p), 'utf8');

// The phrase appears in the page intro too, so the section is taken from its
// own HEADING; slicing on the first mention read the wrong block entirely.
const assistantSection = (html) => {
  const at = html.indexOf('<h2>The Trip Planner assistant</h2>');
  return at === -1 ? '' : html.slice(at);
};

const app = read('apps/trip-planner/js/app.js');
const logic = read('apps/trip-planner/js/trip-logic.js');
const privacy = read('privacy.html');

test('the assistant default tier is a single explicit literal', () => {
  const m = /localStorage\.getItem\(ASSIST_TIER_KEY\) \|\| '(copy|byok|site)'/.exec(app);
  assert.ok(m, 'the default tier is no longer read the way this test can see it');
  assert.equal(m[1], 'site', 'the default changed: privacy.html has to change with it');
});

test('privacy.html names the tier the app actually selects', () => {
  const section = assistantSection(privacy);
  assert.ok(section, 'the assistant section heading is gone');
  const intro = section.slice(0, section.indexOf('</ol>'));
  // the free shared assistant is the selected mode, and the page must not say
  // the traveller lands on the mode that sends nothing
  assert.match(intro, /free shared assistant/i);
  assert.doesNotMatch(intro, /default,?\s*on a fresh browser,?\s*is the copy-and-paste/i);
  // and it must still be honest that nothing leaves before Send
  assert.match(intro, /press Send|when you press Send/i);
});

test('privacy.html names the booking facts the assistant is NOT given', () => {
  const section = assistantSection(privacy);
  // the field list the code holds back
  const m = /const ASSIST_OMITTED_FIELDS = \[([^\]]+)\]/.exec(logic);
  assert.ok(m, 'ASSIST_OMITTED_FIELDS moved; privacy.html describes it by name');
  const fields = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(fields.sort(), ['bookBy', 'confirmation', 'paidBy', 'payment', 'splitAmounts'].sort());
  // each one, in the words the page uses for it
  for (const phrase of [/confirmation-number field/i, /who paid/i, /how a cost is split/i, /payment tag/i, /booking deadline/i]) {
    assert.match(section, phrase, `privacy.html no longer says it holds back ${phrase}`);
  }
});

test('the Last reviewed date moved when the assistant prose did', () => {
  const m = /<strong>Last reviewed:<\/strong>\s*([0-9]{1,2} [A-Za-z]+ [0-9]{4})/.exec(privacy);
  assert.ok(m, 'the Last reviewed line is gone');
  const when = new Date(m[1]);
  assert.ok(!Number.isNaN(when.valueOf()), `unparseable review date: ${m[1]}`);
  assert.ok(when >= new Date('2026-08-23'), 'the assistant section changed on 2026-08-23; the review date must not predate it');
});
