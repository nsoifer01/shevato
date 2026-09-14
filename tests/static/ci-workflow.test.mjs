// The pull-request pipeline's invariants (.github/workflows/ci.yml).
//
// Each assertion below is a property whose loss would not show up as a red
// run: it would show up as a green one that means less. A required check that
// silently stops being required, a job that skips and reads as passing, a
// step that fails quietly, a second workflow re-running the estate. None of
// them breaks a build, which is exactly why they are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CI = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

// Top-level jobs as { id: block text }, from the two-space-indented keys under
// `jobs:`. No YAML dependency; the workflow is hand-written and regular.
function jobs(yaml) {
  const body = yaml.slice(yaml.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const out = {};
  let id = null;
  for (const line of body.split('\n')) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) { id = m[1]; out[id] = ''; continue; }
    if (id) out[id] += `${line}\n`;
  }
  return out;
}
const J = jobs(CI);
const ifOf = (id) => {
  const m = /^ {4}if:\s*(.+)$/m.exec(J[id] || '');
  return m ? m[1].trim() : null;
};

// Branch protection's required contexts. These strings are the contract.
const REQUIRED = ['lint', 'test', 'browser', 'rules'];

test('every required status check is a job in ci.yml', () => {
  for (const id of REQUIRED) assert.ok(J[id] !== undefined, `job "${id}" is required by branch protection`);
});

test('the pipeline runs on every pull request and every push to master, unfiltered', () => {
  const on = CI.slice(CI.indexOf('\non:'), CI.indexOf('\njobs:'));
  assert.match(on, /^ {2}pull_request:\s*$/m);
  assert.match(on, /^ {2}push:\n {4}branches: \[master\]$/m);
  assert.doesNotMatch(on, /paths(-ignore)?:/,
    'a path filter makes a required check report nothing, which blocks every unrelated pull request forever');
});

test('a gated job is skipped only when plan positively decided the tree already passed', () => {
  // Skipped required checks read as PASSING, so a gate that skips on anything
  // other than a successful "already tested" answer would wave a pull request
  // through untested. The only skip path: a push, plan succeeded, run=false.
  const GATE = "${{ !cancelled() && (github.event_name != 'push' || needs.plan.result != 'success' || needs.plan.outputs.run == 'true') }}";
  for (const id of ['lint', 'test', 'browser-shard', 'rules-shard']) {
    assert.equal(ifOf(id), GATE, `job "${id}" must use the fail-open gate`);
    assert.match(J[id], /^ {4}needs: plan$/m, `job "${id}" reads plan's answer`);
  }
  assert.equal(ifOf('plan'), "github.event_name == 'push'", 'plan only ever runs for a push');
});

test('each required verdict runs whatever happened to its shards', () => {
  for (const [verdict, shards] of [['browser', 'browser-shard'], ['rules', 'rules-shard']]) {
    assert.equal(ifOf(verdict), 'always()',
      `without always() a failed or cancelled ${shards} leaves the required check SKIPPED, which reads as passing`);
    assert.match(J[verdict], new RegExp(`SHARDS: \\$\\{\\{ needs\\.${shards}\\.result \\}\\}`));
    assert.match(J[verdict], /"\$SHARDS" != success/);
  }
});

test('the Arena e2e split covers every scenario exactly once', () => {
  assert.match(J['rules-shard'], /^ {8}group: \[1, 2\]$/m);
  assert.match(J['rules-shard'], /ARENA_E2E_GROUP: \$\{\{ matrix\.group \}\}/);
  const e2e = readFileSync(join(REPO_ROOT, 'apps/arena/e2e/emulator.mjs'), 'utf8');
  const chainLast = Number((/const CHAIN_LAST = (\d+);/.exec(e2e) || [])[1]);
  assert.ok(chainLast > 0, 'emulator.mjs must still define CHAIN_LAST');
  const labels = [...e2e.matchAll(/await guard\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length >= 10, `found ${labels.length} scenarios; the parser broke`);
  // The runner throws on an unprefixed label; this says so before a CI run does.
  assert.deepEqual(labels.filter((l) => !/^S\d+:/.test(l)), [], 'every scenario label needs its S<n>: prefix');
  const nums = labels.map((l) => Number(/^S(\d+):/.exec(l)[1]));
  assert.ok(nums.some((n) => n <= chainLast) && nums.some((n) => n > chainLast), 'both groups must hold scenarios');
  assert.equal(new Set(nums).size, nums.length, 'scenario numbers must be unique');
});

test('nothing in the gate is allowed to fail quietly', () => {
  // The KEY, not the phrase: the workflow's comments explain why it is absent.
  const keys = CI.split('\n').filter((l) => /^\s*continue-on-error:/.test(l));
  assert.deepEqual(keys, [], 'a step whose failure is ignored changes what a green run means');
});

test('superseded pull-request runs are cancelled; master runs never are', () => {
  assert.match(CI, /^ {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m);
});

test('browser shards run in CI mode, where a precondition skip is a failure', () => {
  assert.match(J['browser-shard'], /BROWSER_TEST_CI: '1'/);
  assert.match(J['browser-shard'], /--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/,
    'the shard total comes from the matrix itself, so it cannot drift from the shard list');
});

test('every job has a timeout shorter than GitHub\'s six-hour default', () => {
  for (const [id, block] of Object.entries(J)) {
    if (/^ {4}uses:/m.test(block)) continue; // a called workflow sets its own
    const m = /^ {4}timeout-minutes: (\d+)$/m.exec(block);
    assert.ok(m, `job "${id}" has no timeout-minutes`);
    assert.ok(Number(m[1]) <= 45, `job "${id}" timeout ${m[1]} is not a real bound`);
  }
});

test('the unit job reports each test file\'s cost against the per-file bound, on every outcome', () => {
  // --test-timeout bounds whole files. PR #542 took it for a per-test bound,
  // and nothing showed how close any file ran until the weekly coverage job
  // killed two (2026-09-14).
  assert.match(J.test, /--test-reporter=\.\/scripts\/test-file-times\.mjs --test-reporter-destination=unit-file-times\.md/);
  const summarize = J.test.slice(J.test.indexOf('- name: Summarize results'));
  assert.match(summarize, /^ {8}if: always\(\)$/m);
  assert.match(summarize, /unit-file-times\.md \| tee -a "\$GITHUB_STEP_SUMMARY"/);
});

test('the retired per-suite workflows stay retired', () => {
  // Four workflows used to gate a pull request, each with its own broken
  // "already tested?" guard. A second copy of any of them would run the same
  // suites twice and could disagree with this one.
  for (const f of ['test.yml', 'lint.yml', 'browser-tests.yml', 'arena-rules.yml', 'cross-browser.yml']) {
    assert.equal(existsSync(join(REPO_ROOT, '.github/workflows', f)), false, `${f} was folded into ci.yml / scheduled.yml`);
  }
});
