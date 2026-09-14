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
// THE DIGEST PAIR ALONE HAD A HOLE (2026-09-12 audit C-1). The pair lives in
// THIS file, so an editor could overwrite CURRENT.digest in place, leave
// PREVIOUS alone and the date unchanged, and every assertion above passed: the
// "changed text demands a changed date" check only compares the two slots the
// editor had just rewritten. Nothing inside a file the editor controls can be
// an anchor. Git history can: the last test below compares the policy text and
// the date against the commit this change is being made ON TOP OF (the
// uncommitted tree against HEAD, a pull request's merge commit against its
// base, a branch against its merge base with master, and a push to master
// against the commit before it). If the words moved there, the date must have
// moved forward too, whatever this file's pair says.
//
// WHEN THIS TEST FAILS, the fix is not to regenerate blindly:
//   1. bump `Last reviewed:` in privacy.html to the date the change SHIPS;
//   2. move CURRENT to PREVIOUS here, and write the new date + digest
//      (the failure message prints the digest it computed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(join(REPO_ROOT, 'privacy.html'), 'utf8');

// The two most recent reviews. Append by moving CURRENT down to PREVIOUS.
const PREVIOUS = { date: '13 September 2026', digest: '4714d2c71107a3a1dd66644ca7ac739e710c9a869742bfe60b96d02fb5a2576c' };
const CURRENT = {
  date: '14 September 2026',
  digest: '4351bc291b5a3173df07cd933517cbbb7db10ced9d142900912c601876f0d8ef',
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
 * The privacy.html this change is being made on top of, and why that commit.
 * null only when there is no usable history (a shallow single-commit checkout,
 * or no git at all), in which case the digest pair above is the only guard.
 */
function baseVersion() {
  const atHead = tryGit(['show', 'HEAD:privacy.html']);
  if (atHead === null) return null;
  // 1. Uncommitted edits: the working tree against the commit it sits on.
  if (atHead !== html) return { src: atHead, from: 'HEAD (uncommitted changes)' };
  const line = tryGit(['rev-list', '--parents', '-n', '1', 'HEAD']);
  if (!line) return null;
  const [head, ...parents] = line.trim().split(/\s+/);
  const at = (rev, from) => {
    const src = tryGit(['show', `${rev}:privacy.html`]);
    return src === null ? null : { src, from };
  };
  // 2. A pull request is tested as a merge commit; its first parent is the base.
  if (parents.length >= 2) return at(parents[0], 'first parent of the merge commit (the pull request base)');
  // 3. A branch: the point it left master.
  for (const ref of ['origin/master', 'master']) {
    const mb = tryGit(['merge-base', 'HEAD', ref]);
    if (mb && mb.trim() !== head) return at(mb.trim(), `merge base with ${ref}`);
  }
  // 4. master itself (a push run): the commit before this one.
  if (parents.length === 1) return at(parents[0], 'the previous commit');
  return null;
}

test('THE RULE, anchored in git: changed policy text since the base commit demands a later review date', (t) => {
  const base = baseVersion();
  if (!base) {
    t.diagnostic('no git base resolvable (shallow or missing history); the digest pair above is the only guard in this run');
    return;
  }
  if (policyText(base.src) === policyText()) return; // no policy text change: nothing to demand
  const was = reviewDate(base.src);
  const now = reviewDate();
  assert.notEqual(now, was,
    `The policy text in privacy.html changed since ${base.from}, but "Last reviewed" still reads ${now}. `
    + 'Bump it to the date this change SHIPS. (Overwriting CURRENT.digest in this file does not satisfy this check.)');
  assert.ok(new Date(now) > new Date(was),
    `"Last reviewed" moved from ${was} to ${now}, which is not later. A changed policy needs a later review date.`);
});
