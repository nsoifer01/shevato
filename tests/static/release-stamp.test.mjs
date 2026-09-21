import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

import { stamp, releaseId, TOKEN } from '../../scripts/stamp-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ANALYTICS = resolve(ROOT, 'assets/js/analytics.js');

// A release_id that names a commit nobody can find is worse than none: it is
// the field an app_error is triaged by. On 2026-09-20 production served
// `aa8e531086ea`, the pre-squash commit of a branch that had just been
// deleted, because the deploy worktree was built twice and the second build
// took the "already stamped" early return.
test('a reused build tree is re-stamped, not frozen at the first build', () => {
  const first = stamp(`  var RELEASE_ID = '${TOKEN}';`, 'aa8e531086ea');
  assert.match(first, /var RELEASE_ID = 'aa8e531086ea';/);
  // The same tree, built again at a different commit: the OLD stamp must go.
  const second = stamp(first, '0f04c2aa6639');
  assert.match(second, /var RELEASE_ID = '0f04c2aa6639';/);
  assert.doesNotMatch(second, /aa8e531086ea/);
});

test('re-stamping the same build id writes nothing', () => {
  const stamped = stamp(`  var RELEASE_ID = '${TOKEN}';`, 'abc123def456');
  // null means "no write needed", which keeps a repeated build a no-op.
  assert.equal(stamp(stamped, 'abc123def456'), null);
});

test('stamp leaves a file it does not recognise alone', () => {
  assert.equal(stamp('var SOMETHING_ELSE = 1;', 'abc123def456'), null);
});

test('the shipped analytics helper still carries a stampable token', () => {
  // If this file stops matching, the deploy silently ships release_id "dev"
  // and every error in GA4 becomes unattributable.
  const src = readFileSync(ANALYTICS, 'utf8');
  assert.ok(src.includes(TOKEN), 'analytics.js must carry the release token');
  const out = stamp(src, '0f04c2aa6639');
  assert.match(out, /var RELEASE_ID = '0f04c2aa6639';/);
  assert.doesNotMatch(out, new RegExp(TOKEN));
});

test('releaseId refuses anything that is not filesystem-safe', () => {
  assert.equal(releaseId({ COMMIT_REF: 'abcdef123456' }, () => null), 'abcdef123456');
  assert.equal(releaseId({ COMMIT_REF: 'a b; rm -rf /' }, () => null), null);
  assert.equal(releaseId({}, () => null), null);
});
