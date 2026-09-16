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
// the review date must be the day that change ships. It keeps the last two
// (date, digest) pairs. Editing the policy makes CURRENT.digest stop matching
// the page, and the only way back to green is to record a new pair.
//
// THE DIGEST PAIR ALONE HAD A HOLE (2026-09-12 audit C-1). The pair lives in
// THIS file, so an editor could overwrite CURRENT.digest in place, leave
// PREVIOUS alone and the date unchanged, and every pair assertion passed.
// Nothing inside a file the editor controls can be an anchor. Git history can:
// the last test below compares the policy text and the date against the commit
// this change is being made ON TOP OF (the uncommitted tree against HEAD, a
// pull request's merge commit against its base, a branch against its merge
// base with master, and a push to master against the commit before it).
//
// THE DATE IS A UTC DAY, AND NEVER SOMETHING TO WAIT FOR (2026-09-14). The git
// check used to demand a date strictly LATER than the base commit's. That
// refused an honest same-day follow-up: PR #533 published a policy edit dated
// 13 September, corrections found later that day could only ship under a later
// date, and they sat as "blocked until 14 September". A session then read "the
// 14th" as the owner's local midnight and proposed holding a green PR for hours
// when it was already the 14th in UTC. Nothing here named a zone either:
// `new Date('14 September 2026')` is local midnight wherever the test runs.
// The rule now lives in privacy-review-date-rule.mjs, pinned case by case in
// its own test: the review date is the UTC calendar day the change reaches
// master, which is today for anything not on master yet and the commit's own
// day for a commit already there; two changes on one UTC day share its date;
// and a date past today's UTC day is refused.
//
// WHEN THIS TEST FAILS, the fix is not to regenerate blindly:
//   1. set `Last reviewed:` in privacy.html to the UTC date the change ships
//      (the failure names it; `date -u '+%-d %B %Y'` prints today's);
//   2. move CURRENT to PREVIOUS here, and write the new date + digest
//      (the failure message prints the digest it computed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedPolicyDateProblem, formatReviewDay, futureDateProblem, reviewDay, utcDay,
} from './privacy-review-date-rule.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(REPO_ROOT, 'privacy.html'), 'utf8');

// The two most recent reviews. Append by moving CURRENT down to PREVIOUS.
const PREVIOUS = { date: '15 September 2026', digest: '0cb35252ddb8c21102864552ac04a8a8d433e5760a4e61776ab659afbd90cd06' };
const CURRENT = {
  // The analytics section gained the "started" half of each app's funnel
  // (workout_started, race_form_opened, rival_added, trip_created,
  // team_connected, match_form_opened, match_logged, game_started) and a
  // paragraph saying why those events exist.
  date: '16 September 2026',
  digest: '7cfd8d056553663dc4aee4f232fb28695475e521d89282b00d723cd1dcb225bd',
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
function policyText(src = html) {
  const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(src);
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

function reviewDate(src = html) {
  const m = /<strong>Last reviewed:<\/strong>\s*([0-9]{1,2} [A-Za-z]+ [0-9]{4})/.exec(src);
  assert.ok(m, 'the Last reviewed line is gone from privacy.html');
  return m[1];
}

test('privacy.html still states a parseable review date', () => {
  assert.ok(reviewDay(reviewDate()), `unparseable review date: ${reviewDate()}`);
});

test('the review date is not past today in UTC', () => {
  // A date past today's UTC day is either a typo or a promise about a review
  // that has not happened. No slack: the day is UTC for everyone, so there is
  // no skew between a CI runner and whoever wrote the date to absorb.
  const problem = futureDateProblem(reviewDate(), Date.now());
  assert.equal(problem, null, problem);
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
    + `  1. set \`Last reviewed:\` in privacy.html to the UTC date this change ships (today in UTC: ${formatReviewDay(utcDay(Date.now()))})\n`
    + '  2. in tests/static/privacy-review-date.test.mjs, move CURRENT to PREVIOUS and record:\n'
    + `       { date: '<that date>', digest: '${actual}' }\n`
    + 'A second change on the same UTC day keeps the date; the git check below says which day it is.');
});

test('a changed policy never moves the review date backwards', () => {
  // Equal dates are allowed: two policy changes on one UTC day were both
  // reviewed that day. Whether the date is the RIGHT day is the git check's
  // job below, because only git knows when the change was made.
  if (CURRENT.digest === PREVIOUS.digest) return;   // text unchanged: nothing to demand
  assert.ok(reviewDay(CURRENT.date) >= reviewDay(PREVIOUS.date),
    `the policy text changed and the review date moved back from ${PREVIOUS.date} to ${CURRENT.date}`);
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

// ---------------------------------------------------------------------------
// The anchor the digest pair cannot provide: git.
// ---------------------------------------------------------------------------

function tryGit(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * The privacy.html this change is being made on top of, why that commit, and
 * when the change ships. A commit already on master shipped at its own commit
 * time (a GitHub squash merge is stamped at the merge), so a rerun on a later
 * day judges it by the day it landed; anything else (uncommitted edits, a pull
 * request's test merge, a branch) has not shipped, so it ships no earlier than
 * now. null only when there is no usable history (a shallow single-commit
 * checkout, or no git at all), in which case the digest pair above is the only
 * guard.
 */
function baseVersion() {
  const atHead = tryGit(['show', 'HEAD:privacy.html']);
  if (atHead === null) return null;
  const notShipped = { shipsAt: Date.now(), shipsFrom: 'now (not on master yet)' };
  // 1. Uncommitted edits: the working tree against the commit it sits on.
  if (atHead !== html) return { src: atHead, from: 'HEAD (uncommitted changes)', ...notShipped };
  const line = tryGit(['rev-list', '--parents', '-n', '1', 'HEAD']);
  if (!line) return null;
  const [head, ...parents] = line.trim().split(/\s+/);
  const onMaster = ['origin/master', 'master'].some((ref) => tryGit(['merge-base', '--is-ancestor', 'HEAD', ref]) !== null);
  let ships = notShipped;
  if (onMaster) {
    const committed = Date.parse(String(tryGit(['log', '-1', '--format=%cI', 'HEAD'])).trim());
    if (Number.isNaN(committed)) return null;
    ships = { shipsAt: committed, shipsFrom: 'the commit time of HEAD, already on master' };
  }
  const at = (rev, from) => {
    const src = tryGit(['show', `${rev}:privacy.html`]);
    return src === null ? null : { src, from, ...ships };
  };
  // 2. A merge commit: its first parent is the base (a pull request's test merge, or a merge on master).
  if (parents.length >= 2) return at(parents[0], 'first parent of the merge commit');
  // 3. A branch: the point it left master.
  for (const ref of ['origin/master', 'master']) {
    const mb = tryGit(['merge-base', 'HEAD', ref]);
    if (mb && mb.trim() !== head) return at(mb.trim(), `merge base with ${ref}`);
  }
  // 4. master itself (a push run): the commit before this one.
  if (parents.length === 1) return at(parents[0], 'the previous commit');
  return null;
}

test('THE RULE, anchored in git: changed policy text carries the UTC date it ships', (t) => {
  const base = baseVersion();
  if (!base) {
    t.diagnostic('no git base resolvable (shallow or missing history); the digest pair above is the only guard in this run');
    return;
  }
  if (policyText(base.src) === policyText()) return; // no policy text change: nothing to demand
  t.diagnostic(`base: ${base.from}; ships: ${base.shipsFrom}, ${utcDay(base.shipsAt)} UTC`);
  const problem = changedPolicyDateProblem({ was: reviewDate(base.src), date: reviewDate(), shipsAt: base.shipsAt });
  assert.equal(problem, null,
    `The policy text in privacy.html changed since ${base.from}: ${problem} `
    + '(Overwriting CURRENT.digest in this file does not satisfy this check.)');
});
