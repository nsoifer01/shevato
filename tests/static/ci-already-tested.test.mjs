// The push-to-master "already tested?" decision, tested against a stubbed
// GitHub API (scripts/ci-already-tested.mjs).
//
// A wrong SKIP leaves master untested and a wrong RUN costs one duplicate
// run, so every uncertain answer must come out as RUN. The cases below cover
// each way the evidence can be missing or disagree, and the one way it can
// agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../../scripts/bot-pr-autopilot.mjs';
import { decide, main, CI_WORKFLOW_PATH } from '../../scripts/ci-already-tested.mjs';

const REPO = 'nsoifer01/shevato';
const SQUASH = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    calls.push(path);
    const answer = await handler(path);
    const { status = 200, body = {} } = answer && answer.status ? answer : { body: answer };
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

const merged = (over = {}) => ({ number: 600, merged_at: '2026-09-14T00:00:00Z', merge_commit_sha: SQUASH, head: { sha: HEAD }, ...over });
const ciRun = (over = {}) => ({
  id: 1, path: CI_WORKFLOW_PATH, status: 'completed', conclusion: 'success', created_at: '2026-09-13T23:00:00Z', ...over,
});

// The world in which skipping is correct; each test perturbs one fact of it.
function world({ pulls = [merged()], trees = { [SQUASH]: 'T1', [HEAD]: 'T1' }, runs = [ciRun()], fail = null } = {}) {
  return stubFetch((path) => {
    if (fail && path.includes(fail)) return { status: 500, body: { message: 'boom' } };
    if (path.endsWith(`/commits/${SQUASH}/pulls`)) return pulls;
    const commit = /\/git\/commits\/([0-9a-f]{40})$/.exec(path);
    if (commit) return { sha: commit[1], tree: { sha: trees[commit[1]] } };
    if (path.includes('/actions/runs?')) return { workflow_runs: runs };
    return { status: 404, body: { message: 'unexpected path' } };
  });
}

const decideIn = async (w, over = {}) => decide({
  api: createApi({ token: 't', repo: REPO, fetchImpl: w.fetchImpl }), event: 'push', sha: SQUASH, ...over,
});

test('a squash merge whose tree passed on its pull request is skipped', async () => {
  const w = world();
  const r = await decideIn(w);
  assert.equal(r.run, false, r.reason);
  assert.match(r.reason, /#600/);
  assert.ok(w.calls.some((p) => p.includes(`head_sha=${HEAD}`) && p.includes('event=pull_request')),
    'the runs looked up must be the pull-request runs on the head');
});

test('a pull_request, schedule or dispatch event always runs, without asking the API', async () => {
  for (const event of ['pull_request', 'schedule', 'workflow_dispatch', undefined]) {
    const w = world();
    const r = await decideIn(w, { event });
    assert.equal(r.run, true, String(event));
    assert.deepEqual(w.calls, [], 'no API call is needed to decide a non-push event');
  }
});

test('a push that is not a pull request merge runs', async () => {
  assert.equal((await decideIn(world({ pulls: [] }))).run, true);
  assert.equal((await decideIn(world({ pulls: [merged({ merge_commit_sha: 'c'.repeat(40) })] }))).run, true,
    'a pull request that merely CONTAINS the commit is not the one that produced it');
  assert.equal((await decideIn(world({ pulls: [merged({ merged_at: null })] }))).run, true);
});

test('THE REASON THIS EXISTS: the tree comparison works for a single-parent squash commit', async () => {
  // No second parent is consulted anywhere: the head comes from the pull
  // request, not from HEAD^2.
  const w = world();
  assert.equal((await decideIn(w)).run, false);
  assert.ok(!w.calls.some((p) => p.includes('^2')));
});

test('a merge that produced a tree its head never had runs', async () => {
  const r = await decideIn(world({ trees: { [SQUASH]: 'T-merged', [HEAD]: 'T-head' } }));
  assert.equal(r.run, true);
  assert.match(r.reason, /no pull-request run tested/);
});

test('the latest pull-request run must be a completed pass', async () => {
  for (const latest of [
    ciRun({ conclusion: 'failure' }), ciRun({ conclusion: 'cancelled' }),
    ciRun({ status: 'in_progress', conclusion: null }), ciRun({ conclusion: 'action_required' }),
  ]) {
    assert.equal((await decideIn(world({ runs: [latest] }))).run, true, JSON.stringify(latest));
  }
});

test('an older pass does not excuse a newer failure on the same head', async () => {
  const runs = [
    ciRun({ id: 1, created_at: '2026-09-13T20:00:00Z', conclusion: 'success' }),
    ciRun({ id: 2, created_at: '2026-09-13T22:00:00Z', conclusion: 'failure' }),
  ];
  assert.equal((await decideIn(world({ runs }))).run, true);
});

test('only this workflow counts: a pass of some other workflow is not evidence', async () => {
  const r = await decideIn(world({ runs: [ciRun({ path: '.github/workflows/cross-browser.yml' })] }));
  assert.equal(r.run, true);
  assert.match(r.reason, /no pull-request run/);
});

test('every API failure runs the suites', async () => {
  for (const fail of ['/pulls', '/git/commits/', '/actions/runs']) {
    const r = await decideIn(world({ fail }));
    assert.equal(r.run, true, fail);
    assert.match(r.reason, /could not/);
  }
});

test('main writes run= to GITHUB_OUTPUT, and a missing token still means RUN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'already-tested-'));
  const out = join(dir, 'out');
  const summary = join(dir, 'summary');
  const w = world();
  const skipped = await main({
    env: { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: SQUASH, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    fetchImpl: w.fetchImpl, log: () => {},
  });
  assert.equal(skipped.run, false);
  assert.equal(readFileSync(out, 'utf8'), 'run=false\n');
  assert.match(readFileSync(summary, 'utf8'), /Skipping the suites/);

  const out2 = join(dir, 'out2');
  const noToken = await main({ env: { GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: 'push', GITHUB_SHA: SQUASH, GITHUB_OUTPUT: out2 }, log: () => {} });
  assert.equal(noToken.run, true);
  assert.equal(readFileSync(out2, 'utf8'), 'run=true\n');
});
