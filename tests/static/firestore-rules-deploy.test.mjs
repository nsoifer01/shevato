// An undeployed ruleset must be written down, not merely true.
//
// Firestore rules are not deployed by CI, by a Netlify build, or by merging a
// PR. `apps/maptap-rivals/README.md` says so and `docs-contracts.test.mjs`
// keeps that claim honest by failing if any workflow, npm script or
// netlify.toml line ever gains a `firestore:rules` deploy. So merging a rules
// change does nothing in production, and from inside the repo a merged PR
// looks exactly like a release. That is not hypothetical: the repo's ruleset
// ran five weeks ahead of production between 2026-08-04 and 2026-09-08, across
// five separate commits, and it was found by hand rather than by anything.
//
// Nothing here can read the live ruleset: firebaserules.googleapis.com refuses
// local Application Default Credentials without a quota project, and giving CI
// a credential that could deploy rules is exactly the thing not to do. So this
// does the next best thing, which is to make the GAP a committed fact:
// `firestore-rules-deploy.json` records the digest of what shipped, and an
// unreleased change cannot sit in the tree without a note saying what is
// outstanding. Drift stops being invisible and becomes a line in a diff.
//
// The record is a promise, not proof. It is only as good as the person who
// runs `node scripts/firestore-rules-status.mjs --record-deployed` straight
// after a real deploy, the same way privacy.html's review date is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesDigest, readRecord } from '../../scripts/firestore-rules-status.mjs';

const STATUS = 'node scripts/firestore-rules-status.mjs';
const record = readRecord();
const now = rulesDigest();

test('the record describes the firestore.rules that is actually committed', () => {
  assert.equal(record.digest, now,
    'firestore.rules changed without firestore-rules-deploy.json being updated.'
    + ` Run \`${STATUS}\` to see the state. A rules change reaches production only when somebody`
    + ' deploys it by hand, so the repo has to carry the fact that one is outstanding.');
});

test('a ruleset that has not been released says what is outstanding', () => {
  const released = record.digest === record.lastConfirmedDeploy.digest;
  if (released) {
    assert.equal(record.awaitingDeploy, null,
      'the committed ruleset matches the last confirmed deploy, so awaitingDeploy must be cleared;'
      + ' a note left behind teaches the next reader to ignore it');
    return;
  }
  assert.equal(typeof record.awaitingDeploy, 'string',
    'the committed ruleset is not the one last recorded as deployed, so awaitingDeploy must say what is waiting');
  assert.ok(record.awaitingDeploy.length >= 80,
    'awaitingDeploy must name WHAT is undeployed and why it matters, not just that something is');
});

test('the last confirmed deploy is a real, dated record', () => {
  const { digest, on, how } = record.lastConfirmedDeploy;
  assert.match(digest, /^[0-9a-f]{64}$/, 'lastConfirmedDeploy.digest must be a sha256 of a ruleset');
  assert.match(on, /^\d{4}-\d{2}-\d{2}$/, 'lastConfirmedDeploy.on must be an ISO date');
  assert.match(how, /firebase-tools.*firestore:rules/,
    'lastConfirmedDeploy.how must name the command that released it');
});
