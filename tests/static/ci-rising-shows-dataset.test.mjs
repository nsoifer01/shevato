// The Rising Shows dataset steps of the browser shards in ci.yml, tested
// (2026-09-12; moved from browser-tests.yml on 2026-09-14).
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
const WORKFLOW = '.github/workflows/ci.yml';
// The steps themselves live in one composite action every job uses.
const ACTION = '.github/actions/rising-shows-dataset/action.yml';
const SPLITTER = 'apps/rising-shows/scripts/split-data.js';
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// Extract a step's `run: |` body from the workflow, dedented, exactly as
// Actions would hand it to bash. No ${{ }} expressions appear in this one.
// ---------------------------------------------------------------------------
function stepScript(stepName) {
  const lines = read(ACTION).split('\n');
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

// The `path:` block of a dataset cache step, as a list of repo-relative paths.
function cachePaths(stepName = 'Restore the Rising Shows dataset') {
  const lines = read(ACTION).split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(at >= 0, `no "${stepName}" step in ${WORKFLOW}`);
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

// The raw lines of one step, from its `- name:` to the next step.
function stepBlock(stepName) {
  const lines = read(ACTION).split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(at >= 0, `no "${stepName}" step in ${WORKFLOW}`);
  const indent = lines[at].match(/^\s*/)[0].length;
  const out = [lines[at]];
  for (let i = at + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() !== '' && l.match(/^\s*/)[0].length <= indent) break;
    out.push(l);
  }
  return out.join('\n');
}
const keyOf = (stepName) => {
  const m = /^\s*key:\s*(.+)$/m.exec(stepBlock(stepName));
  assert.ok(m, `no key: in "${stepName}"`);
  return m[1].trim();
};

test('restore and save carry the same files under the same key', () => {
  assert.deepEqual(cachePaths('Save the Rising Shows dataset'), cachePaths('Restore the Rising Shows dataset'));
  assert.equal(keyOf('Save the Rising Shows dataset'), keyOf('Restore the Rising Shows dataset'));
});

// A top-level ci.yml job's block, from `  <id>:` to the next job.
function ciJob(id) {
  const yaml = read(WORKFLOW);
  const at = yaml.indexOf(`\n  ${id}:\n`);
  assert.ok(at >= 0, `ci.yml has no ${id} job`);
  const rest = yaml.slice(at + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test('every job that needs the real catalogue prepares it through the one action', () => {
  // browser-shard: three suites; test: the real-catalogue parity tests, which
  // never ran on CI before; dataset-cache: keeps the entry warm.
  for (const id of ['browser-shard', 'test', 'dataset-cache']) {
    assert.match(ciJob(id), /uses: \.\/\.github\/actions\/rising-shows-dataset\s*$/m, `${id} must use the dataset action`);
  }
  assert.doesNotMatch(read(WORKFLOW), /actions\/cache\/(restore|save)@[^\n]*\n[\s\S]{0,400}rising-shows-dataset-/,
    'no job may carry its own copy of the dataset cache steps');
});

test('master keeps the entry warm, because pushes no longer run the shards', () => {
  // Without it, a push the plan job skips saves nothing on master, and a cache
  // saved inside a pull request is invisible to every other pull request.
  const job = ciJob('dataset-cache');
  assert.match(job, /^ {4}if: github\.event_name == 'push'$/m, 'dataset-cache runs on pushes to master');
  assert.doesNotMatch(job, /needs: plan/, 'and is not skipped by plan: it exists for the runs plan skips');
});

test('a data refresh warms its new pin on master before its pull request opens', () => {
  // The refresh bot merges with GITHUB_TOKEN, whose push starts no ci.yml run,
  // so dataset-cache never sees a data change: after #543 (2026-09-14) pull
  // requests missed the new pin until the weekly run saved it.
  const wf = read('.github/workflows/refresh-rising-shows.yml');
  const warm = wf.indexOf('- name: Warm the CI dataset cache for the new pin');
  assert.ok(warm > 0, 'refresh-rising-shows.yml must warm the dataset cache');
  const step = wf.slice(warm, wf.indexOf('\n      # ', warm));
  assert.match(step, /uses: \.\/\.github\/actions\/rising-shows-dataset\s*$/m, 'through the one action, so the key cannot drift');
  assert.match(step, /if: steps\.change\.outputs\.changed == 'true'/, 'on the same gate as the upload that writes the pin');
  assert.ok(wf.indexOf('- name: Upload data to the rising-shows-data release') < warm,
    'after the upload step writes the new data-release.json, or the key is the old pin');
  assert.ok(warm < wf.indexOf('- name: Open the refresh pull request'),
    'before the pull request, whose shards are the first to restore it');
});

test('the cache key is the committed data pin, never the run', () => {
  // A run-id key never hits exactly, so every run saved another ~100 MB entry
  // and evicted other caches (the Arena emulator jar among them).
  const key = keyOf('Restore the Rising Shows dataset');
  assert.doesNotMatch(key, /run_id|run_number|github\.sha/, key);
  assert.match(key, /apps\/rising-shows\/data-release\.json/, 'the pin is what identifies the dataset');
});

test('no cached path is, or contains, a tracked file', () => {
  // apps/rising-shows/data/ holds a tracked season-overviews.json. Caching the
  // directory restored a stale copy OVER the pull request's version.
  const paths = cachePaths('Restore the Rising Shows dataset');
  const tracked = execFileSync('git', ['ls-files', '--', ...paths], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  assert.equal(tracked, '', `a cache restore would overwrite tracked files:\n${tracked}`);
});

test('preparing the dataset is never allowed to fail quietly', () => {
  // continue-on-error here turned a failed download into 64 skipped assertions
  // and a green shard.
  assert.equal(/^\s*continue-on-error:/m.test(stepBlock('Prepare the Rising Shows dataset')), false,
    'the Prepare step must not carry continue-on-error');
});

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
