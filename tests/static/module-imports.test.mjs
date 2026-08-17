// Relative ES-module specifier integrity for browser-shipped JavaScript.
//
// internal-links.test.mjs already asserts that every href/src in the HTML
// pages resolves to a real, git-tracked file. Nothing asserted the same for
// module specifiers INSIDE the JavaScript, and that gap shipped a production
// 404: apps/fpl-planner/js/ui/settings.js reached the sync layer through
// `import('../../../sync-system/storage-sync-robust.js')` - three levels up
// from apps/fpl-planner/js/ui/ is /apps/, so the browser requested
// /apps/sync-system/storage-sync-robust.js and got a 404. The canonical module
// is at the repo root, /sync-system/, which needs four. Unit tests missed it
// because the resolution hook stubbed the module by suffix, at any depth.
//
// A dynamic import is the dangerous case: unlike a static import it is not
// fetched at page load, so a wrong path stays invisible until a user reaches
// the one code path that triggers it - here, deleting their account data.
//
// Checked for every relative specifier (static `from`, side-effect `import`,
// and dynamic `import()` with a literal argument):
//   - resolves to a file that exists on disk, AND
//   - that file is tracked by git (a gitignored build artifact satisfying an
//     import is a 404 in a fresh clone and on production until a build runs).
// Skipped: non-relative specifiers (bare, absolute, http(s):, blob:) and
// dynamic imports whose argument is computed rather than a literal - neither
// is statically resolvable, and both are rare here.
//
// Zero dependencies. `git ls-files` is spawned once for the tracked set; if
// git is unavailable the tracked check degrades to exists-on-disk with a
// console note, never a false failure. Mirrors internal-links.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// -- Files under test --------------------------------------------------------
//
// Browser-shipped JavaScript only. Node-only code (scripts/, netlify/
// functions/, test helpers) is excluded: a bad path there fails loudly the
// moment the script runs, whereas a bad path in shipped code 404s silently in
// somebody's browser. Third-party vendor bundles are excluded outright.
const EXCLUDED_SEGMENTS = new Set([
  'vendor', 'node_modules', 'tests', 'tests-rules', 'e2e', 'scripts', 'experiments',
]);

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

const TRACKED = trackedFiles();
if (!TRACKED) {
  console.log('module-imports: git unavailable, tracked check degraded to exists-on-disk');
}
const TRACKED_SET = TRACKED ? new Set(TRACKED.map((p) => p.split('/').join(sep))) : null;

// The corpus is walked from disk rather than taken from `git ls-files`, so the
// test still runs (with the tracked check degraded) when git is unavailable.
// Gitignored build output under these roots is JS the browser really does load,
// so scanning it is correct; only the tracked ASSERTION needs git.
function walkJs(relDir, acc) {
  let entries;
  try { entries = readdirSync(join(REPO_ROOT, relDir), { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (EXCLUDED_SEGMENTS.has(e.name) || e.name.startsWith('.')) continue;
    const child = `${relDir}/${e.name}`;
    if (e.isDirectory()) walkJs(child, acc);
    else if (e.isFile() && /\.(js|mjs)$/.test(e.name)) acc.push(child);
  }
  return acc;
}

const SHIPPED_JS = ['apps', 'sync-system', 'assets/js']
  .flatMap((root) => walkJs(root, []))
  .sort();

// -- Comment stripping -------------------------------------------------------
//
// Specifiers are read from source with comments blanked out, so a commented-out
// or merely discussed path (this file's own header, for one) cannot be mistaken
// for a live import. Single/double/template strings are tracked so that a "//"
// inside a URL literal is not read as the start of a comment. Replaced with
// spaces rather than removed to keep offsets stable.
function stripComments(src) {
  const out = [...src];
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; i += 1; continue; }
      out[i] = ' ';
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }
    // inside a string literal
    if (c === '\\') { i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code';
    }
    i += 1;
  }
  return out.join('');
}

// -- Specifier extraction ----------------------------------------------------
//
// Only relative specifiers are captured (the leading "." in each pattern):
// bare, absolute and http(s): specifiers are not filesystem paths and are not
// this test's business.
const PATTERNS = [
  // import x from './a.js'  |  export { y } from '../b.js'
  /\bfrom\s*['"](\.[^'"]*)['"]/g,
  // import './side-effect.js'
  /\bimport\s*['"](\.[^'"]*)['"]/g,
  // await import('./lazy.js')
  /\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g,
];

function specifiersIn(src) {
  const code = stripComments(src);
  const found = new Set();
  for (const re of PATTERNS) {
    for (const m of code.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

// -- Tests -------------------------------------------------------------------

test('every relative module specifier in shipped JS resolves to a tracked file', () => {
  assert.ok(SHIPPED_JS.length > 50, `expected to scan a real corpus, got ${SHIPPED_JS.length} files`);

  const broken = [];
  for (const file of SHIPPED_JS) {
    const abs = join(REPO_ROOT, file.split('/').join(sep));
    const src = readFileSync(abs, 'utf8');
    for (const spec of specifiersIn(src)) {
      // Strip any ?query / #hash cache-busting suffix before resolving.
      const bare = spec.replace(/[?#].*$/, '');
      const target = resolve(dirname(abs), bare);
      const rel = relative(REPO_ROOT, target);
      if (!existsSync(target)) {
        broken.push(`${file} -> ${spec} (no such file: ${rel})`);
      } else if (TRACKED_SET && !TRACKED_SET.has(rel)) {
        broken.push(`${file} -> ${spec} (exists but is not tracked by git: ${rel})`);
      }
    }
  }

  assert.deepEqual(broken, [], `Unresolvable module specifiers:\n  ${broken.join('\n  ')}`);
});

test('every reference to the sync layer points at the canonical root module', () => {
  // The sync system is a single shared implementation at the repo root. Any
  // app reaching it must land on exactly that file - a path that resolves
  // somewhere else means either a 404 or, worse, a duplicate sync layer.
  const CANONICAL = join(REPO_ROOT, 'sync-system', 'storage-sync-robust.js');
  assert.ok(existsSync(CANONICAL), 'the canonical sync module must exist at sync-system/storage-sync-robust.js');

  const referring = [];
  for (const file of SHIPPED_JS) {
    const abs = join(REPO_ROOT, file.split('/').join(sep));
    const src = readFileSync(abs, 'utf8');
    for (const spec of specifiersIn(src)) {
      if (!spec.endsWith('storage-sync-robust.js')) continue;
      referring.push([file, spec, resolve(dirname(abs), spec)]);
    }
  }

  // Guards the guard: if the import is ever renamed away, this test must not
  // keep passing vacuously.
  assert.ok(
    referring.some(([file]) => file === 'apps/fpl-planner/js/ui/settings.js'),
    'fpl-planner settings.js is expected to import the sync layer for its delete-cloud-copy action'
  );

  const wrong = referring
    .filter(([, , target]) => target !== CANONICAL)
    .map(([file, spec, target]) => `${file} -> ${spec} (resolves to ${relative(REPO_ROOT, target)})`);

  assert.deepEqual(wrong, [], `Sync-layer imports not resolving to sync-system/storage-sync-robust.js:\n  ${wrong.join('\n  ')}`);
});
