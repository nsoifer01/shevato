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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/arena-rules.yml';
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

// A git stub, so the test never depends on the checkout's history. CI checks
// out at fetch-depth 1, which is exactly where a history-dependent test would
// start failing for a reason that has nothing to do with the logic.
function runScope({ event, before = 'a'.repeat(40), after = 'b'.repeat(40), files = [], missing = '', diffFails = false }) {
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
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'git'), gitStub);
  chmodSync(join(bin, 'git'), 0o755);

  const fakeFiles = join(dir, 'files.txt');
  writeFileSync(fakeFiles, files.length ? `${files.join('\n')}\n` : '');
  const outPath = join(dir, 'gh-output');
  writeFileSync(outPath, '');
  const scriptPath = join(dir, 'scope.sh');
  writeFileSync(scriptPath, SCRIPT);

  const log = execFileSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: outPath,
      FAKE_FILES: fakeFiles,
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
test('the arena emulator workflow reports on every pull request', () => {
  const yaml = read(WORKFLOW);
  const on = yaml.slice(yaml.indexOf('\non:'), yaml.indexOf('\njobs:'));

  assert.ok(!/^\s+paths(-ignore)?:/m.test(on),
    'on.<event>.paths makes the workflow silent on a change that misses the filter, and a required '
    + 'check that never reports blocks the pull request forever. Filter inside the job instead.');
  assert.match(on, /^\s*pull_request:\s*$/m, 'it must still run on every pull request');

  // The check context branch protection names is the job id. Renaming the job
  // silently un-requires it, because the old context simply stops appearing.
  assert.match(yaml, /^\n?jobs:\n {2}rules:$/m,
    'the job must stay `rules`: that string is the required-status-check context');
});

// ---------------------------------------------------------------------------
// What runs the suites, and what does not.
// ---------------------------------------------------------------------------
const RUNS = {
  'the ruleset itself': ['firestore.rules'],
  'the RTDB half of the boundary': ['database.rules.json'],
  'the emulator wiring': ['firebase.json'],
  'the arena app': ['apps/arena/js/app.js'],
  'the rules suite': ['apps/arena/tests-rules/rules.test.mjs'],
  'the multiplayer e2e': ['apps/arena/e2e/emulator.mjs'],
  'the sync layer the app writes through': ['sync-system/storage-sync-robust.js'],
  'the scripts this job runs': ['package.json'],
  'the node version it runs them on': ['.nvmrc'],
  'the workflow itself': ['.github/workflows/arena-rules.yml'],
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
  // sync-system TEST. Those files are node tests and their stubs; the `test`
  // workflow already covers them, and neither emulator suite loads them.
  'PR #511 (an unrelated app removed, one sync-system test line touched)': [
    'apps/quotescout/index.html',
    'netlify/functions/quotescout.mjs',
    'sync-system/tests/app-naming-consistency.test.mjs',
  ],
  'a sync-system test helper': ['sync-system/tests/helpers/firestore-stub.mjs'],
};

for (const [what, files] of Object.entries(SKIPS)) {
  test(`a change to ${what} skips the suites and still reports`, () => {
    assert.equal(runScope({ event: 'pull_request', files }).run, '0', files.join(', '));
  });
}

// ---------------------------------------------------------------------------
// Derived, not restated: whatever the e2e imports from outside apps/arena is
// an input to this job, and must be in the trigger.
// ---------------------------------------------------------------------------
test('every module the multiplayer e2e imports from outside apps/arena is an input', () => {
  const e2eDir = 'apps/arena/e2e';
  const sources = ['emulator.mjs', 'run-emulator.mjs'];
  const escaping = new Set();

  for (const file of sources) {
    const src = read(join(e2eDir, file));
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const abs = resolve(REPO_ROOT, e2eDir, m[1]);
      const rel = relative(REPO_ROOT, abs).split('\\').join('/');
      if (!rel.startsWith('apps/arena/')) escaping.add(rel);
    }
  }

  // The one that exists today is tests/browser/cdp.mjs, and it was NOT in the
  // old trigger: the driver the whole suite runs on could be rewritten without
  // this job ever running. If that set is ever empty, the parser broke.
  assert.ok(escaping.size > 0, 'expected at least one cross-tree import to check');

  for (const path of escaping) {
    assert.equal(runScope({ event: 'pull_request', files: [path] }).run, '1',
      `${path} is imported by the multiplayer e2e but does not trigger it`);
  }
});

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
    assert.match(log, /Running both suites:/);
  });
}
