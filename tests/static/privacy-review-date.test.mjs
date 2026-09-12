// "Last reviewed" cannot stand still while the policy text moves.
//
// WHY THIS FILE EXISTS (2026-09-12)
// ---------------------------------
// PR #530 rewrote the two identifier paragraphs in privacy.html and bumped the
// review date 7 -> 11 September, which was correct on the day the paragraphs
// were written. The branch then ran another full day (four more commits) and
// merged on the 12th, so the published page shipped claiming it had last been
// reviewed the day before its own content changed.
//
// Nothing caught it. The only existing check was a FLOOR
// (`the Last reviewed date moved when the assistant prose did`, now honestly
// renamed): it asserted the date parsed and was not older than 2026-08-23, and
// any date after that satisfied it. Its NAME claimed it compared the date to
// the prose; it never read the prose at all, which is exactly why the gap
// looked covered.
//
// So this file asserts the real rule, mechanically: if the policy text changes,
// the review date must change with it. It keeps the last two (date, digest)
// pairs. Editing the policy makes CURRENT.digest stop matching the page, and
// the only way back to green is to record a new pair - at which point the
// `changed text demands a changed date` assertion below refuses a pair whose
// date equals the previous one.
//
// WHEN THIS TEST FAILS, the fix is not to regenerate blindly:
//   1. bump `Last reviewed:` in privacy.html to the date the change SHIPS;
//   2. move CURRENT to PREVIOUS here, and write the new date + digest
//      (the failure message prints the digest it computed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(REPO_ROOT, 'privacy.html'), 'utf8');

// The two most recent reviews. Append by moving CURRENT down to PREVIOUS.
const PREVIOUS = { date: '11 September 2026', digest: 'baseline-before-the-guard-existed' };
const CURRENT = {
  date: '12 September 2026',
  digest: '1e4ad68e39a0ee4eb0eb205aa4d3be2843303dd0107982c3c32228cdecb75c72',
};

/**
 * The prose the date is a claim ABOUT: everything inside <main>, with HTML
 * comments and tags stripped and whitespace flattened.
 *
 * Comments are excluded on purpose, so that editing the rule note beside the
 * date (or any other comment) does not demand a new review date. Markup is
 * excluded too: re-wrapping a paragraph is not a policy change. What remains is
 * the words a reader actually sees, which is what "reviewed" refers to.
 * The review date itself is removed, or every bump would invalidate its own
 * digest.
 */
function policyText() {
  const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html);
  assert.ok(main, 'privacy.html has no <main> block to fingerprint');
  return main[1]
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/Last reviewed:\s*\d{1,2}\s+[A-Za-z]+\s+\d{4}\.?/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const digestOf = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function reviewDate() {
  const m = /<strong>Last reviewed:<\/strong>\s*([0-9]{1,2} [A-Za-z]+ [0-9]{4})/.exec(html);
  assert.ok(m, 'the Last reviewed line is gone from privacy.html');
  return m[1];
}

test('privacy.html still states a parseable review date', () => {
  const when = new Date(reviewDate());
  assert.ok(!Number.isNaN(when.valueOf()), `unparseable review date: ${reviewDate()}`);
});

test('the review date is not in the future', () => {
  // A date ahead of today is either a typo or a promise about a review that has
  // not happened. One day of slack absorbs timezone skew between a CI runner
  // and whoever wrote it.
  const when = new Date(reviewDate());
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  assert.ok(when <= tomorrow, `review date ${reviewDate()} is in the future`);
});

test('privacy.html and this file agree on the review date', () => {
  assert.equal(reviewDate(), CURRENT.date,
    'privacy.html was edited without recording the new review date here, or the other way round. '
    + 'Both move together, in the same pull request.');
});

test('THE RULE: the policy text cannot change while the review date stands still', () => {
  const actual = digestOf(policyText());
  assert.equal(actual, CURRENT.digest,
    'The words in privacy.html changed. That is a review.\n'
    + '  1. bump `Last reviewed:` in privacy.html to the date this change SHIPS\n'
    + '  2. in tests/static/privacy-review-date.test.mjs, move CURRENT to PREVIOUS and record:\n'
    + `       { date: '<the new date>', digest: '${actual}' }\n`
    + 'Do not record a new digest under the old date: the next assertion refuses it.');
});

test('a changed policy demands a changed date, not just a new digest', () => {
  // The half that gives the check teeth. Recording a fresh digest under the
  // previous date is exactly the mistake PR #530 shipped, so it is the one
  // thing this file will not accept.
  if (CURRENT.digest === PREVIOUS.digest) return;   // text unchanged: nothing to demand
  assert.notEqual(CURRENT.date, PREVIOUS.date,
    `the policy text changed but the review date stayed at ${CURRENT.date}`);
});

test('the fingerprint covers the prose a reader sees, and excludes the comments around it', () => {
  // Guards the extraction itself: a regex that silently matched nothing would
  // make every assertion above vacuous.
  const text = policyText();
  assert.ok(text.length > 4000, `policy text extraction collapsed to ${text.length} chars`);
  assert.ok(/day number and run through a one-way hash/.test(text), 'the identifier prose is missing from the fingerprint');
  assert.ok(!/TODO\(owner\)/.test(text), 'HTML comments leaked into the fingerprint');
  assert.ok(!/<p>|<strong>/.test(text), 'markup leaked into the fingerprint');
  assert.ok(!/Last reviewed:\s*\d/.test(text), 'the review date leaked into its own fingerprint');
});
