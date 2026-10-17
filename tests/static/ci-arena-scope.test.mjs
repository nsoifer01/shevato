// The arena emulator job's own gate, tested (2026-09-08).
//
// Two PRs merged red on 2026-09-08 (#509, #511) because `rules` was not a
// required status check, and it could not become one: the workflow was
// filtered by `on.<event>.paths`, and a path-filtered workflow reports NOTHING
// when a change misses the filter. A required check that never reports parks
// the pull request on "Expected - Waiting for status to be reported" forever.
//
// The fix moved the filter off the trigger and into a "Scope" step, so the job
// always runs and always reports, and only the expensive suites are
// conditional. That trades one silent failure mode for another, though: the
// decision is now a regex inside a shell script, and if it drifts, the job
// reports GREEN while running no emulator at all. An authorization boundary
// that reports success without being checked is worse than one that is not
// checked at all.
//
// So this file runs the REAL script, extracted from the workflow, against
// canned file lists and a stubbed git. Nothing here restates the regex; every
// assertion drives the shell and reads its GITHUB_OUTPUT. The cross-tree
// import case is derived from the e2e's own import statements, so adding a new
// shared dependency to the suite without widening the trigger fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The `rules` job lives in the single ci workflow since 2026-09-14 (it was
// arena-rules.yml); its Scope step is unchanged.
const WORKFLOW = '.github/workflows/ci.yml';
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// Extract the Scope step's shell body, dedented, exactly as Actions would run
// it. Only `env:` carries ${{ }} expressions, so the body is plain bash.
// ---------------------------------------------------------------------------
function scopeScript() {
  const lines = read(WORKFLOW).split('\n');
  const step = lines.findIndex((l) => /^\s*- name: Scope - /.test(l));
  assert.ok(step >= 0, 'the workflow must still have a step named "Scope - ..."');
  const runAt = lines.findIndex((l, i) => i > step && /^\s*run: \|\s*$/.test(l));
  assert.ok(runAt > step, 'the Scope step must still carry a literal `run: |` block');

  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { body.push(''); continue; }
    if (line.match(/^\s*/)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const SCRIPT = scopeScript();
const CI = read(WORKFLOW);

// A git stub, so the test never depends on the checkout's history. CI checks
// out at fetch-depth 1, which is exactly where a history-dependent test would
// start failing for a reason that has nothing to do with the logic.
function runScope({ event, before = 'a'.repeat(40), after = 'b'.repeat(40), files = [], missing = '', diffFails = false, ciOld = null, ciNew = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'arena-scope-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gitStub = [
    '#!/usr/bin/env bash',
    '# Answers only what the Scope step asks of git.',
    'if [ "$1" = "cat-file" ]; then',
    '  case "$3" in',
    `    ${missing || '__none__'}*) exit 1 ;;`,
    '    *) exit 0 ;;',
    '  esac',
    'fi',
    'if [ "$1" = "diff" ]; then',
    diffFails ? '  exit 128' : '  cat "$FAKE_FILES"',
    '  exit 0',
    'fi',
    'if [ "$1" = "merge-base" ]; then echo "$2"; exit 0; fi',
    '# The workflow at a commit: the head reads the new copy, anything else the old.',
    'if [ "$1" = "show" ]; then',
    '  case "$2" in',
    `    ${after}:*) cat "$FAKE_CI_NEW" ;;`,
    '    *) cat "$FAKE_CI_OLD" ;;',
    '  esac',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'git'), gitStub);
  chmodSync(join(bin, 'git'), 0o755);

  const ciOldPath = join(dir, 'ci-old.yml');
  const ciNewPath = join(dir, 'ci-new.yml');
  // By default the workflow changed in its arena job, which is an input.
  writeFileSync(ciOldPath, ciOld ?? CI);
  writeFileSync(ciNewPath, ciNew ?? CI.replace(/^ {2}rules-shard:$/m, '  rules-shard:\n    # touched'));
  const fakeFiles = join(dir, 'files.txt');
  writeFileSync(fakeFiles, files.length ? `${files.join('\n')}\n` : '');
  const outPath = join(dir, 'gh-output');
  writeFileSync(outPath, '');
  const scriptPath = join(dir, 'scope.sh');
  writeFileSync(scriptPath, SCRIPT);

  // `-e`, because Actions runs a `run:` block as `bash -e {0}` and this test
  // did not. That single missing flag is why the suite passed while the real
  // step failed: under -e a `grep` that matches nothing aborts the script, and
  // matching nothing IS the skip decision. Running it any other way tests a
  // shell the workflow never uses.
  const log = execFileSync('bash', ['-e', scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: outPath,
      FAKE_FILES: fakeFiles,
      FAKE_CI_OLD: ciOldPath,
      FAKE_CI_NEW: ciNewPath,
      EVENT: event,
      PR_BASE: event === 'pull_request' ? before : '',
      PR_HEAD: event === 'pull_request' ? after : '',
      PUSH_BEFORE: event === 'push' ? before : '',
      PUSH_AFTER: event === 'push' ? after : '',
    },
  });

  const out = readFileSync(outPath, 'utf8');
  const m = /^run=(\d)$/m.exec(out);
  assert.ok(m, `the Scope step must always write a run= output; wrote ${JSON.stringify(out)}\n${log}`);
  return { run: m[1], log };
}

// ---------------------------------------------------------------------------
// The property that makes the job requireable at all.
// ---------------------------------------------------------------------------
test('the workflow holding the arena emulator job reports on every pull request', () => {
  const yaml = read(WORKFLOW);
  const on = yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\njobs:'));

  assert.ok(!/^\s+paths(-ignore)?:/m.test(on),
    'on.<event>.paths makes the workflow silent on a change that misses the filter, and a required '
    + 'check that never reports blocks the pull request forever. Filter inside the job instead.');
  assert.match(on, /^\s*pull_request:\s*$/m, 'it must still run on every pull request');

  // The check context branch protection names is the job id. Renaming the job
  // silently un-requires it, because the old context simply stops appearing.
  assert.match(yaml, /^ {2}rules:$/m,
    'the job must stay `rules`: that string is the required-status-check context');
});

// ---------------------------------------------------------------------------
// What runs the suites, and what does not.
// ---------------------------------------------------------------------------
const RUNS = {
  'the ruleset itself': ['firestore.rules'],
  'the emulator wiring': ['firebase.json'],
  'the arena app': ['apps/arena/js/app.js'],
  'the rules suite': ['apps/arena/tests-rules/rules.test.mjs'],
  'the scripts this job runs': ['package.json'],
  'the node version it runs them on': ['.nvmrc'],
  'the arena job in the workflow': ['.github/workflows/ci.yml'],
  'one arena file among many unrelated ones': ['index.html', 'apps/gym-tracker/js/app.js', 'apps/arena/README.md'],
};

for (const [what, files] of Object.entries(RUNS)) {
  test(`a change to ${what} runs the emulator suites`, () => {
    assert.equal(runScope({ event: 'pull_request', files }).run, '1', files.join(', '));
  });
}

const SKIPS = {
  'documentation': ['README.md', 'CLAUDE.md', 'apps/trip-planner/FINDINGS.md'],
  'another app entirely': ['apps/fpl-planner/js/planner.js', 'apps/fpl-planner/index.html'],
  // The literal shape of PR #511: an app deleted, and one app-count line in a
  // sync-system TEST.
  'PR #511 (an unrelated app removed, one sync-system test line touched)': [
    'apps/quotescout/index.html',
    'netlify/functions/quotescout.mjs',
    'sync-system/tests/app-naming-consistency.test.mjs',
  ],
  // The suite drives the rules over the emulator's REST API and loads no
  // page; these were inputs only while the multiplayer e2e ran (removed
  // 2026-10-17). The required browser estate boots the arena page with them.
  'the client-side Firebase seams and the sync layer': ['firebase-config.js', 'firebase-firestore.js', 'sync-system/storage-sync-robust.js'],
  'a shared script, stylesheet or partial the arena page loads': ['assets/js/main.js', 'assets/css/main.css', 'partials/header.html'],
};

for (const [what, files] of Object.entries(SKIPS)) {
  test(`a change to ${what} skips the suites and still reports`, () => {
    assert.equal(runScope({ event: 'pull_request', files }).run, '0', files.join(', '));
  });
}

// ---------------------------------------------------------------------------
// Fail-safe. Every unknown must run the suites, never skip them: ten wasted
// minutes against an unchecked authorization boundary reported green.
// ---------------------------------------------------------------------------
const FAIL_SAFE = {
  'a scheduled run has no diff to scope by': { event: 'schedule' },
  'a manual dispatch has no diff to scope by': { event: 'workflow_dispatch' },
  'a push with no predecessor': { event: 'push', before: '0'.repeat(40), files: ['README.md'] },
  'a push whose predecessor was garbage-collected': { event: 'push', before: 'c'.repeat(40), missing: 'c', files: ['README.md'] },
  'a pull request whose base is unreachable': { event: 'pull_request', missing: 'a', files: ['README.md'] },
  'a pull request whose head is unreachable': { event: 'pull_request', missing: 'b', files: ['README.md'] },
  'git diff failing outright': { event: 'pull_request', diffFails: true, files: ['README.md'] },
};

for (const [what, opts] of Object.entries(FAIL_SAFE)) {
  test(`${what} runs the suites rather than skipping them`, () => {
    const { run, log } = runScope(opts);
    assert.equal(run, '1', log);
    assert.match(log, /Running the rules suite:/);
  });
}

// ---------------------------------------------------------------------------
// The workflow is an input only where it can move the arena job (2026-10-17).
// ---------------------------------------------------------------------------
test('a workflow change outside the arena job and the header skips the suites', () => {
  const other = CI.replace(/^ {2}lint:$/m, '  lint:\n    # an unrelated job changed');
  assert.notEqual(other, CI);
  const { run, log } = runScope({ event: 'pull_request', files: ['.github/workflows/ci.yml'], ciNew: other });
  assert.equal(run, '0', log);
  assert.match(log, /not an input/);
  // The same edit beside an arena input still runs them.
  assert.equal(runScope({ event: 'pull_request', files: ['.github/workflows/ci.yml', 'firestore.rules'], ciNew: other }).run, '1');
});

test('a workflow change to its header (triggers, concurrency, permissions) runs the suites', () => {
  const header = CI.replace(/^permissions:$/m, '# touched\npermissions:');
  assert.notEqual(header, CI);
  assert.equal(runScope({ event: 'pull_request', files: ['.github/workflows/ci.yml'], ciNew: header }).run, '1');
});

test('the arena part of the workflow is its last two jobs, as the scope script assumes', () => {
  const jobs = [...CI.slice(CI.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
  assert.deepEqual(jobs.slice(-2), ['rules-shard', 'rules'],
    'arena_part() reads from `rules-shard:` to the end of the file; a job added after them would count as arena');
});
