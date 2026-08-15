// node --check over every first-party script CI syntax-checks, PLUS the
// assets/js files CI misses. Makes the CI syntax gate locally runnable and
// complete: a parse error in any of these files currently ships silently to
// the browser unless CI's hand-maintained list happens to cover it.
//
// Mirrors .github/workflows/test.yml:
//   - gym-tracker tree: apps/gym-tracker/js/**/*.js + sw.js (parsed as ESM
//     via apps/gym-tracker/package.json "type": "module", exactly like CI).
//   - site scripts list: the eight classic scripts CI checks.
// Adds the four first-party files the testing audit flagged as uncovered:
//   analytics-404.js, back-to-top.js, escape-html.js, sync-status.js
//   (all verified to parse cleanly as classic scripts).
//
// Exclusions, verified rather than assumed:
//   - assets/js/jquery.min.js, breakpoints.min.js, browser.min.js: vendored
//     minified bundles; CI skips them ("Node's parser chokes on some legacy
//     syntax"), and vendored code is not ours to gate.
//   - assets/js/util.js: vendored HTML5 UP template helper (minified single
//     line); same vendored rationale.
//   - sync-system/*.js: mixed module styles loaded as browser modules or
//     classic scripts; CI documents that --check would misclassify them, and
//     they are behaviorally covered by sync-system/tests/ instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The eight classic site scripts CI checks (keep in sync with
// .github/workflows/test.yml "Syntax check (site scripts)").
const CI_SITE_SCRIPTS = [
  'assets/js/analytics.js',
  'assets/js/apex-redirect.js',
  'assets/js/global-icons.js',
  'assets/js/language-switcher.js',
  'assets/js/main.js',
  'assets/js/pagination.js',
  'assets/js/passive-events-fix.js',
  'assets/js/redirect-countdown.js'
];

// First-party assets/js files CI does NOT check (audit finding).
const UNCOVERED_SITE_SCRIPTS = [
  'assets/js/analytics-404.js',
  'assets/js/back-to-top.js',
  'assets/js/escape-html.js',
  'assets/js/sync-status.js'
];

// Gym-tracker tree, matching CI's `git ls-files 'apps/gym-tracker/js/**/*.js'
// 'apps/gym-tracker/sw.js'`. Uses git for exact parity; falls back to an fs
// walk when git is unavailable.
function gymTrackerFiles() {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', 'apps/gym-tracker/js/**/*.js', 'apps/gym-tracker/sw.js'],
      { cwd: REPO_ROOT }
    ).toString('utf8');
    const files = out.split('\n').filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // fall through to the walk
  }
  const found = [];
  (function walk(dirRel) {
    for (const entry of readdirSync(join(REPO_ROOT, dirRel))) {
      const rel = join(dirRel, entry);
      const st = statSync(join(REPO_ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if (entry.endsWith('.js')) found.push(rel.split(sep).join('/'));
    }
  })('apps/gym-tracker/js');
  if (existsSync(join(REPO_ROOT, 'apps/gym-tracker/sw.js'))) found.push('apps/gym-tracker/sw.js');
  return found;
}

const ALL_FILES = [...gymTrackerFiles(), ...CI_SITE_SCRIPTS, ...UNCOVERED_SITE_SCRIPTS];

test('the syntax sweep covers a plausible file count', () => {
  // Tripwire against the gym-tracker discovery silently returning nothing.
  assert.ok(ALL_FILES.length >= 20, `expected 20+ first-party scripts, found ${ALL_FILES.length}`);
});

for (const file of ALL_FILES) {
  test(`node --check ${file}`, () => {
    const abs = join(REPO_ROOT, file);
    assert.ok(existsSync(abs), `${file} is missing - update the list to match the tree`);
    // cwd REPO_ROOT so the nearest package.json ("type": "module" for
    // gym-tracker) classifies the file exactly as CI's invocation does.
    const res = spawnSync(process.execPath, ['--check', abs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000
    });
    assert.equal(res.status, 0, `syntax error in ${file}:\n${res.stderr}`);
  });
}
