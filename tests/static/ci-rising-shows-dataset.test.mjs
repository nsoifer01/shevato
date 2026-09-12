// The Rising Shows dataset step in browser-tests.yml, tested (2026-09-12).
//
// WHY THIS FILE EXISTS
// --------------------
// The dataset is gitignored and lives on a rolling GitHub release, so CI
// downloads it, splits it, and caches the result. 64 assertions across three
// browser suites are gated on it being there: without it they SKIP, and a
// skipped assertion is a green shard that checked nothing.
//
// Two details drifted apart and nobody noticed for a week:
//
//   * the cache `path:` list held data.json, data-index.json and data/, but
//     NOT shows-index.json, which is the file the finder actually boots from;
//   * the "do I already have it?" guard tested data-index.json, which the
//     cache DID restore.
//
// So every run after the first cache save restored a dataset the app could not
// boot, decided it was a hit, skipped the rebuild, and silently skipped all 64
// assertions. PR #530 shipped a 4.12:1 colour-contrast regression on the
// low-confidence shape badge straight past four green browser shards; the same
// suite caught it on the first local run against real data.
//
// The lesson generalises past this one workflow: a cache-hit guard must test
// the artifact the CONSUMER needs, and the cache must carry everything the
// producer writes. Both halves are pinned below, and the shell is the real one
// extracted from the workflow, driven against canned trees with a stubbed npm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/browser-tests.yml';
const SPLITTER = 'apps/rising-shows/scripts/split-data.js';
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// Extract a step's `run: |` body from the workflow, dedented, exactly as
// Actions would hand it to bash. No ${{ }} expressions appear in this one.
// ---------------------------------------------------------------------------
function stepScript(stepName) {
  const lines = read(WORKFLOW).split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(at >= 0, `no "${stepName}" step in ${WORKFLOW}`);
  const runAt = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  assert.ok(runAt > at && runAt < at + 12, `no "run: |" directly under "${stepName}"`);
  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if (l.match(/^\s*/)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

// The `path:` block of the dataset cache step, as a list of repo-relative paths.
function cachePaths() {
  const lines = read(WORKFLOW).split('\n');
  const at = lines.findIndex((l) => l.trim() === '- name: Cache the Rising Shows dataset');
  assert.ok(at >= 0, `no dataset cache step in ${WORKFLOW}`);
  const pathAt = lines.findIndex((l, i) => i > at && /^\s*path: \|\s*$/.test(l));
  assert.ok(pathAt > at && pathAt < at + 20, 'no "path: |" block in the dataset cache step');
  const indent = lines[pathAt + 1].match(/^\s*/)[0].length;
  const out = [];
  for (let i = pathAt + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '' || l.match(/^\s*/)[0].length < indent) break;
    out.push(l.trim());
  }
  return out;
}

// Everything split-data.js reads and writes, read out of its own paths()
// helper rather than restated here, so a NEW output that nobody caches fails
// this file instead of silently halving a future cache restore.
function splitterArtifacts() {
  const src = read(SPLITTER);
  const block = src.match(/function paths\(appDir\) \{\s*return \{([\s\S]*?)\};\s*\}/);
  assert.ok(block, `could not find paths() in ${SPLITTER}`);
  const out = {};
  for (const m of block[1].matchAll(/(\w+):\s*path\.join\(appDir,\s*([^)]*)\)/g)) {
    const parts = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    out[m[1]] = ['apps/rising-shows', ...parts].join('/');
  }
  return out;
}

const coveredBy = (list, p) => list.some((c) => c === p || p.startsWith(`${c}/`));

test('the cache carries every artifact split-data.js reads or writes', () => {
  const paths = cachePaths();
  const art = splitterArtifacts();
  assert.ok(Object.keys(art).length >= 6, `paths() yielded too little: ${JSON.stringify(art)}`);
  const missing = Object.entries(art)
    .filter(([, p]) => !coveredBy(paths, p))
    .map(([k, p]) => `${k} (${p})`);
  assert.deepEqual(missing, [],
    'A restore that is missing one of these is a PARTIAL cache hit, and the Prepare '
    + 'step will treat it as a full one unless its guard also tests the missing file. '
    + `Cache list: ${JSON.stringify(paths)}. Missing: ${missing.join(', ')}`);
});

test('the finder boot payload is cached by name, not only via its directory', () => {
  // shows-index.json sits at the app root, so no cached directory can carry it
  // by accident. This is the exact line that was absent.
  assert.ok(cachePaths().includes('apps/rising-shows/shows-index.json'),
    'apps/rising-shows/shows-index.json must be listed explicitly in the cache path block');
});

// ---------------------------------------------------------------------------
// Drive the real Prepare step against canned trees.
// ---------------------------------------------------------------------------
function runPrepare(tree) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-dataset-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'npm.log');
  // A stub npm that records the scripts it was asked for and then produces
  // what the real ones produce, so `set -e` and any later check see a
  // realistic tree.
  writeFileSync(join(bin, 'npm'), [
    '#!/bin/sh',
    `echo "$*" >> ${JSON.stringify(log)}`,
    'app="apps/rising-shows"',
    'case "$*" in',
    '  *fetch:rising-shows-data*)',
    '    mkdir -p "$app/data"',
    '    echo "{}" > "$app/data.json"',
    '    echo "{}" > "$app/data/show-modal-extras.json" ;;',
    '  *build:rising-shows:split*)',
    '    mkdir -p "$app/data/detail"',
    '    echo "{}" > "$app/data-index.json"',
    '    echo "{}" > "$app/shows-index.json"',
    '    echo "{}" > "$app/data/kometa-index.json"',
    '    echo "{}" > "$app/data/detail/tt0903747.json" ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  chmodSync(join(bin, 'npm'), 0o755);

  mkdirSync(join(dir, 'apps/rising-shows/data'), { recursive: true });
  for (const [rel, body] of Object.entries(tree)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }

  const script = join(dir, 'prepare.sh');
  writeFileSync(script, stepScript('Prepare the Rising Shows dataset'));
  const stdout = execFileSync('bash', [script], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { stdout, calls };
}

const FULL = {
  'apps/rising-shows/data.json': '{}',
  'apps/rising-shows/data-index.json': '{}',
  'apps/rising-shows/shows-index.json': '{}',
  'apps/rising-shows/data/show-modal-extras.json': '{}',
  'apps/rising-shows/data/kometa-index.json': '{}',
  'apps/rising-shows/data/detail/tt0903747.json': '{}',
};

test('a complete cache restore rebuilds nothing', () => {
  const { stdout, calls } = runPrepare(FULL);
  assert.match(stdout, /dataset restored from cache/);
  assert.deepEqual(calls, [], `nothing should be rebuilt, but npm ran: ${calls.join(' | ')}`);
});

test('THE REGRESSION: a cache without shows-index.json is not a hit', () => {
  // Exactly the tree CI restored on 2026-09-12 (run 34672062079): the raw
  // download and the season-level index are there, the finder payload is not.
  const poisoned = { ...FULL };
  delete poisoned['apps/rising-shows/shows-index.json'];
  const { stdout, calls } = runPrepare(poisoned);
  assert.doesNotMatch(stdout, /dataset restored from cache/,
    'data-index.json alone must never satisfy the guard: that is what silently skipped 64 assertions');
  assert.equal(calls.length, 1, `expected one rebuild call, got: ${calls.join(' | ')}`);
  assert.match(calls[0], /build:rising-shows:split/,
    'the raw dataset was cached, so the split is enough; re-downloading 111 MB is not');
});

test('a cache with only the raw download splits it instead of re-downloading', () => {
  const { stdout, calls } = runPrepare({
    'apps/rising-shows/data.json': '{}',
    'apps/rising-shows/data/show-modal-extras.json': '{}',
  });
  assert.match(stdout, /splitting/);
  assert.deepEqual(calls.map((c) => c.includes('fetch')), [false]);
});

test('an empty tree downloads and splits', () => {
  const { calls } = runPrepare({});
  assert.equal(calls.length, 2, `expected fetch then split, got: ${calls.join(' | ')}`);
  assert.match(calls[0], /fetch:rising-shows-data/);
  assert.match(calls[1], /build:rising-shows:split/);
});

test('a truncated artifact does not count as present', () => {
  // -f would pass on a zero-byte file left behind by an interrupted restore.
  const { stdout, calls } = runPrepare({ ...FULL, 'apps/rising-shows/shows-index.json': '' });
  assert.doesNotMatch(stdout, /dataset restored from cache/);
  assert.equal(calls.length, 1, `expected one rebuild call, got: ${calls.join(' | ')}`);
});
