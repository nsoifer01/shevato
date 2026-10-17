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
  'the Firestore seam every client reaches Firestore through': ['firebase-firestore.js'],
  'the emulator wiring': ['firebase.json'],
  'the arena app': ['apps/arena/js/app.js'],
  'the rules suite': ['apps/arena/tests-rules/rules.test.mjs'],
  'the multiplayer e2e': ['apps/arena/e2e/emulator.mjs'],
  'the sync layer the app writes through': ['sync-system/storage-sync-robust.js'],
  // Read as data by tests/browser/third-party.mjs, so no import walk sees it:
  // every e2e page loads the Firebase SDK from this mirror.
  'the third-party mirror the e2e pages load the SDK from': ['tests/browser/vendor/third-party/manifest.json'],
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
  // sync-system TEST. Those files are node tests and their stubs; the `test`
  // workflow already covers them, and neither emulator suite loads them.
  'PR #511 (an unrelated app removed, one sync-system test line touched)': [
    'apps/quotescout/index.html',
    'netlify/functions/quotescout.mjs',
    'sync-system/tests/app-naming-consistency.test.mjs',
  ],
  'a sync-system test helper': ['sync-system/tests/helpers/firestore-stub.mjs'],
  // Covered by the required browser estate instead, which boots the arena
  // page with them on every pull request (the page-derived test below).
  'a shared script, stylesheet or partial the arena page loads': ['assets/js/main.js', 'assets/css/main.css', 'partials/header.html'],
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
test('every module the multiplayer e2e imports from outside apps/arena, transitively, is an input', () => {
  // TRANSITIVELY: the walk used to read only the two harness files' own
  // imports, so when cdp.mjs started importing tests/browser/third-party.mjs
  // (2026-09-14) nothing here noticed that the SDK every e2e page loads now
  // came from a file the trigger did not list.
  const queue = ['apps/arena/e2e/emulator.mjs', 'apps/arena/e2e/run-emulator.mjs'];
  const seen = new Set();
  const escaping = new Set();

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const rel = relative(REPO_ROOT, resolve(REPO_ROOT, dirname(file), m[1])).split('\\').join('/');
      if (!rel.startsWith('apps/arena/')) escaping.add(rel);
      queue.push(rel);
    }
  }

  // tests/browser/cdp.mjs was NOT in the old trigger: the driver the whole
  // suite runs on could be rewritten without this job ever running. If these
  // are ever missing from the set, the walk broke.
  for (const must of ['tests/browser/cdp.mjs', 'tests/browser/third-party.mjs']) {
    assert.ok(escaping.has(must), `expected the walk to reach ${must}; found ${[...escaping].join(', ')}`);
  }

  for (const path of escaping) {
    assert.equal(runScope({ event: 'pull_request', files: [path] }).run, '1',
      `${path} is imported by the multiplayer e2e but does not trigger it`);
  }
});

// ---------------------------------------------------------------------------
// Derived, not restated, from the APP's side too: whatever apps/arena/js
// imports from outside apps/arena, and whatever that imports in turn, runs
// in-page in every client of both emulator suites, and must be in the trigger.
//
// The e2e-harness walk above could never see firebase-config.js, because the
// harness does not import it: the page does. It is the emulator seam every
// client reaches Firestore through, and it was missing from the trigger until
// 2026-09-13 (site-wide audit C-4), so a pull request touching only that file
// reported `rules` green having run neither suite.
// ---------------------------------------------------------------------------
test('every module the arena app imports from outside apps/arena, transitively, is an input', () => {
  const importRe = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  const queue = readdirSync(join(REPO_ROOT, 'apps/arena/js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `apps/arena/js/${f}`);
  const seen = new Set();
  const escaping = new Set();

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(importRe)) {
      const rel = relative(REPO_ROOT, resolve(REPO_ROOT, dirname(file), m[1])).split('\\').join('/');
      if (rel.startsWith('apps/arena/')) continue;
      escaping.add(rel);
      queue.push(rel);
    }
  }

  // If the app stops importing the seam directly, the walk needs a new root
  // rather than quietly checking nothing.
  assert.ok(escaping.has('firebase-config.js'),
    `expected apps/arena/js to import firebase-config.js; found ${[...escaping].join(', ') || 'nothing'}`);

  for (const path of escaping) {
    assert.equal(runScope({ event: 'pull_request', files: [path] }).run, '1',
      `${path} runs in-page in both emulator suites but does not trigger them`);
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

// ---------------------------------------------------------------------------
// Derived from the PAGE (2026-10-17). The two import walks above see only
// `import` statements. Every first-party file the arena page loads by
// <script src>, <link href> or data-include is either an input to these
// suites or covered by the required browser estate, which boots the arena
// page on every pull request: never neither, which would let a change to it
// report green with nothing having loaded the page.
// ---------------------------------------------------------------------------
test('every first-party file the arena page loads is an emulator input or loaded by the browser estate', () => {
  const html = read('apps/arena/index.html');
  const refs = new Set();
  for (const m of html.matchAll(/\b(?:src|href)="([^"#?]+)/g)) {
    const ref = m[1];
    if (/^(https?:|mailto:|data:|\/\/)/.test(ref) || !/\.(js|mjs|css)$/.test(ref)) continue;
    const rel = ref.startsWith('/') ? ref.slice(1) : relative(REPO_ROOT, resolve(REPO_ROOT, 'apps/arena', ref)).split('\\').join('/');
    if (!rel.startsWith('apps/arena/')) refs.add(rel);
  }
  for (const m of html.matchAll(/data-include="([a-z0-9-]+)"/g)) refs.add(`partials/${m[1]}.html`);
  for (const must of ['assets/js/main.js', 'firebase-config.js', 'partials/header.html']) {
    assert.ok(refs.has(must), `expected the page to load ${must}; found ${[...refs].join(', ')}`);
  }
  // The browser estate's own promise: its apps suite boots the arena page,
  // and the suite is in the estate CI runs on every pull request.
  assert.match(read('tests/browser/suites/apps.mjs'), /goto\(s, base \+ '\/apps\/arena\/'/, 'the apps suite must still boot the arena page');
  assert.match(read('tests/browser/run.mjs'), /'tests\/browser\/suites\/apps\.mjs'/, 'the apps suite must still be in the browser estate');
  assert.match(CI, /^ {2}browser:$/m, 'and `browser` must still be a job (a required check)');
  for (const path of refs) {
    const input = runScope({ event: 'pull_request', files: [path] }).run === '1';
    const browserCovered = /^(assets\/(js|css)\/|partials\/)/.test(path);
    assert.ok(input || browserCovered, `${path} is loaded by the arena page, triggers no emulator suite, and is not covered by the browser estate`);
  }
});

