// The Netlify "may this build be skipped?" decision (scripts/netlify-ignore.mjs).
//
// A wrong BUILD costs about a minute of the 300-minute monthly allowance; a
// wrong SKIP is a change that never reaches shevato.com. So every uncertain
// answer must come out as BUILD, and the one way to SKIP - every changed file
// provably outside the deploy - is proven here from the build's real inputs
// rather than from a list anyone has to remember to update:
//
//   1. classification of real commit shapes, taken from merged pull requests;
//   2. each fail-safe path (missing variable, failed read, unknown or
//      non-ancestor commit, git failure) builds;
//   3. real git histories, including the rename that --no-renames exists for;
//   4. the inert classes are never published, never reached by the build
//      command, the functions bundle or netlify.toml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPath, decide, main, releaseIdFromAnalytics, INERT, RELEASE_PATH } from '../../scripts/netlify-ignore.mjs';
import { isPublished, ROOT_FILES, ROOT_DIRS } from '../../scripts/build-publish-dir.mjs';
import { TOKEN, releaseId } from '../../scripts/stamp-release.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/netlify-ignore.mjs');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');
const published = (rel) => ROOT_FILES.includes(rel) || (ROOT_DIRS.includes(rel.split('/')[0]) && isPublished(rel));

// ---------------------------------------------------------------------------
// 1. Classification
// ---------------------------------------------------------------------------

test('every kind of deploy-relevant change builds', () => {
  const relevant = {
    'frontend app code': ['apps/fpl-planner/js/app.js', 'apps/trip-planner/index.html'],
    'shared JavaScript': ['assets/js/main.js', 'sync-system/storage-sync-robust.js', 'firebase-config.js'],
    'CSS': ['assets/css/main.css', 'apps/gym-tracker/css/styles.css'],
    'static assets': ['images/og/home.png', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'site.webmanifest', 'partials/header.html'],
    'site pages': ['home.html', 'privacy.html', '404.html'],
    'functions and their tests': ['netlify/functions/fpl.mjs', 'netlify/functions/lib/blob-cas.mjs',
      'netlify/functions/package.json', 'netlify/functions/tests/fpl-proxy.test.mjs', 'netlify/functions/README.md'],
    'Netlify and runtime configuration': ['netlify.toml', 'package.json', 'package-lock.json', '.nvmrc'],
    'data': ['apps/rising-shows/data-release.json', 'apps/rising-shows/changelog.json',
      'apps/rising-shows/exports/kometa/finder-went-out-on-top.yml', 'apps/gym-tracker/data/exercises-db.json',
      'apps/rising-shows/finder-presets.json', 'assets/apps-manifest.json'],
    'build scripts': ['scripts/build-publish-dir.mjs', 'scripts/stamp-release.mjs',
      'apps/rising-shows/scripts/build-show-pages.js', 'apps/gym-tracker/scripts/render-exercise-page.cjs',
      'apps/rising-shows/scripts/match.js'],
    'this script': ['scripts/netlify-ignore.mjs'],
    'tooling nobody has proven inert': ['scripts/ci-already-tested.mjs', 'firestore.rules', 'firebase.json',
      '.gitignore', 'deno.lock', 'assets/seo/organization.jsonld', 'docs/diagram.png', 'a-new-top-level-file'],
    'not a plain path': ['', '/etc/passwd', '../outside.md', 'apps/../README.md'],
  };
  for (const [kind, paths] of Object.entries(relevant)) {
    for (const p of paths) assert.equal(classifyPath(p).relevant, true, `${kind}: ${p} must build`);
  }
});

test('documentation, tests, workflows and the lint config are the only skippable changes', () => {
  const inert = [
    'README.md', 'FINDINGS.md', 'CLAUDE.md', 'TESTING-AUDIT.md', 'apps/arena/FINDINGS.md',
    'apps/rising-shows/exports/README.md', 'apps/fpl-planner/experiments/registry.md',
    'tests/static/publish-graph.test.mjs', 'tests/browser/vendor/third-party/x.js', 'apps/arena/tests/scoring.test.js',
    'apps/arena/e2e/emulator.mjs', 'apps/arena/tests-rules/rules.test.mjs', 'sync-system/tests/sync-helpers.test.mjs',
    '.github/workflows/ci.yml', '.github/actions/rising-shows-dataset/action.yml',
    'eslint.config.mjs',
  ];
  for (const p of inert) assert.equal(classifyPath(p).relevant, false, `${p} cannot change the deploy`);
});

// Changed-file lists of real merges to master, from Netlify's deploy history
// (production deploys of 5-14 September 2026). SKIP where every file is inert,
// BUILD otherwise; the conservative cases (#547, #520) are the price of not
// trying to prove which scripts/ files the build never runs.
const HISTORY = [
  { pr: 545, skip: true, files: ['FINDINGS.md', 'apps/gym-tracker/FINDINGS.md'] },
  { pr: 474, skip: true, files: ['FINDINGS.md', 'README.md'] },
  { pr: 483, skip: true, files: ['CLAUDE.md', 'TESTING-AUDIT.md'] },
  { pr: 524, skip: true, files: ['apps/fpl-planner/FINDINGS.md', 'apps/fpl-planner/experiments/registry.md', 'apps/fpl-planner/experiments/subon-rate-shrinkage.md', 'tests/browser/suites/site.mjs'] },
  { pr: 516, skip: true, files: ['.github/workflows/arena-rules.yml', 'apps/arena/FINDINGS.md', 'tests/static/ci-arena-scope.test.mjs'] },
  { pr: 546, skip: false, files: ['apps/rising-shows/changelog.json', 'apps/rising-shows/data-release.json', 'apps/rising-shows/exports/README.md'] },
  { pr: 547, skip: false, files: ['FINDINGS.md', 'scripts/bot-pr-autopilot.mjs', 'tests/static/bot-pr-autopilot.test.mjs'] },
  { pr: 520, skip: false, files: ['scripts/bot-pr-autopilot.mjs', 'tests/static/bot-pr-autopilot.test.mjs'] },
  { pr: 522, skip: false, files: ['assets/css/content-alignment.css'] },
  { pr: 473, skip: false, files: ['apps/trip-planner/e2e/audit-fixes.mjs', 'apps/trip-planner/index.html'] },
  { pr: 482, skip: false, files: ['apps/trip-planner/FINDINGS.md', 'apps/trip-planner/README.md', 'netlify/functions/lib/tp-places-lookup.mjs', 'netlify/functions/lib/tp-places-match.mjs', 'netlify/functions/tests/tp-places-geo.test.mjs'] },
  { pr: 480, skip: false, files: ['.github/workflows/test.yml', 'FINDINGS.md', 'README.md', 'apps/maptap-rivals/e2e/quality.mjs', 'package.json', 'tests/browser/run.mjs'] },
  { pr: 527, skip: false, files: ['apps/maptap-rivals/js/app.js', 'sync-system/storage-sync-robust.js', 'sync-system/tests/sync-helpers.test.mjs'] },
  { pr: 532, skip: false, files: ['CLAUDE.md', 'privacy.html', 'tests/static/privacy-review-date.test.mjs'] },
  { pr: 526, skip: false, files: ['apps/rising-shows/exports/kometa/finder-modern-prestige.yml', 'apps/rising-shows/finder-presets.json'] },
  { pr: 492, skip: false, files: ['apps/trip-planner/FINDINGS.md', 'apps/trip-planner/js/trip-logic.js'] },
];

test('real merges classify the way their deploys should have gone', () => {
  for (const { pr, skip, files } of HISTORY) {
    const skippable = files.every((f) => !classifyPath(f).relevant);
    assert.equal(skippable, skip, `#${pr}: ${files.join(', ')}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Fail-safe paths, against stubbed git and network
// ---------------------------------------------------------------------------

const LIVE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const OLD = '3'.repeat(40);
const stamped = (sha) => read('assets/js/analytics.js').split(TOKEN).join(releaseId({ COMMIT_REF: sha }, () => null));
const ENV = { COMMIT_REF: HEAD, CACHED_COMMIT_REF: OLD, URL: 'https://shevato.com' };

function stubs({ analytics = stamped(LIVE), fetchError = null, diff = 'README.md\0', fail = null } = {}) {
  const calls = { fetch: [], git: [] };
  const fetchText = async (url) => {
    calls.fetch.push(url);
    if (fetchError) throw new Error(fetchError);
    return analytics;
  };
  const git = (args) => {
    calls.git.push(args.join(' '));
    if (fail && args[0] === fail) throw new Error(`git ${fail} failed`);
    if (args[0] === 'rev-parse') return `${LIVE}\n`;
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'diff') return diff;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { fetchText, git, calls };
}

test('the stubbed world in which skipping is right does skip, and asks production what it serves', async () => {
  const s = stubs();
  const r = await decide({ env: ENV, git: s.git, fetchText: s.fetchText });
  assert.equal(r.build, false, r.reason);
  assert.deepEqual(r.paths, ['README.md']);
  assert.equal(s.calls.fetch.length, 1);
  assert.ok(s.calls.fetch[0].startsWith(`https://shevato.com${RELEASE_PATH}?`), s.calls.fetch[0]);
  assert.ok(s.calls.git.some((c) => c === `diff --no-renames --name-only -z ${LIVE} ${HEAD}`),
    'the diff must run from the live commit, without rename detection');
});

test('a missing or unusable build variable builds without asking anyone', async () => {
  for (const env of [
    { ...ENV, COMMIT_REF: undefined }, { ...ENV, COMMIT_REF: 'HEAD' }, { ...ENV, COMMIT_REF: HEAD.slice(0, 12) },
    { ...ENV, CACHED_COMMIT_REF: undefined }, { ...ENV, CACHED_COMMIT_REF: '' },
    { ...ENV, CACHED_COMMIT_REF: HEAD },
  ]) {
    const s = stubs();
    const r = await decide({ env, git: s.git, fetchText: s.fetchText });
    assert.equal(r.build, true, JSON.stringify(env));
    assert.deepEqual(s.calls.fetch, [], 'nothing needs asking');
  }
});

test('"Clear cache and deploy" (no cache, so CACHED_COMMIT_REF equals COMMIT_REF) always builds', async () => {
  const s = stubs();
  const r = await decide({ env: { ...ENV, CACHED_COMMIT_REF: HEAD }, git: s.git, fetchText: s.fetchText });
  assert.equal(r.build, true);
  assert.match(r.reason, /Clear cache and deploy/);
});

test('no trustworthy URL builds', async () => {
  for (const URL of [undefined, '', 'http://shevato.com', 'https://shevato.com/', 'https://shevato.com/x', 'shevato.com']) {
    const s = stubs();
    assert.equal((await decide({ env: { ...ENV, URL }, git: s.git, fetchText: s.fetchText })).build, true, String(URL));
  }
});

test('when production cannot say what it serves, the build runs', async () => {
  const cases = [
    stubs({ fetchError: 'HTTP 503' }),
    stubs({ fetchError: 'The operation was aborted due to timeout' }),
    stubs({ analytics: read('assets/js/analytics.js') }), // unstamped: a local or failed stamp
    stubs({ analytics: '<!doctype html><title>404</title>' }),
    stubs({ analytics: `${stamped(LIVE)}\n${stamped(OLD)}` }), // two ids: ambiguous
  ];
  for (const s of cases) {
    const r = await decide({ env: ENV, git: s.git, fetchText: s.fetchText });
    assert.equal(r.build, true, r.reason);
    assert.equal(s.calls.git.some((c) => c.startsWith('diff')), false, 'no diff is trusted without a live commit');
  }
});

test('an unknown live commit, a non-ancestor, and a failed diff all build', async () => {
  for (const fail of ['rev-parse', 'merge-base', 'diff']) {
    const s = stubs({ fail });
    const r = await decide({ env: ENV, git: s.git, fetchText: s.fetchText });
    assert.equal(r.build, true, fail);
  }
});

test('any relevant file in the diff builds, and names it', async () => {
  const s = stubs({ diff: 'README.md\0assets/css/main.css\0tests/static/x.test.mjs\0' });
  const r = await decide({ env: ENV, git: s.git, fetchText: s.fetchText });
  assert.equal(r.build, true);
  assert.deepEqual(r.paths, ['assets/css/main.css']);
});

test('main reports BUILD when the check itself throws', async () => {
  const lines = [];
  const r = await main({
    env: ENV,
    git: () => { throw new TypeError('boom'); },
    fetchText: async () => { throw new TypeError('boom'); },
    log: (l) => lines.push(l),
  });
  assert.equal(r.build, true);
  assert.match(lines[0], /^\[netlify-ignore\] BUILD: /);
});

test('run as a command, anything short of a proven skip exits non-zero (Netlify builds)', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const out = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /\[netlify-ignore\] BUILD: no usable COMMIT_REF/);
  assert.match(read('scripts/netlify-ignore.mjs'), /process\.exitCode = result\.build \? 1 : 0;/,
    'exit 0 must mean exactly "the decision was SKIP"');
});

test('the release id is read back exactly as stamp-release writes it', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  assert.equal(releaseIdFromAnalytics(stamped(sha)), sha.slice(0, 12));
  assert.equal(releaseIdFromAnalytics(read('assets/js/analytics.js')), null, 'an unstamped helper names no release');
  assert.equal(releaseIdFromAnalytics(''), null);
  assert.equal(releaseIdFromAnalytics(undefined), null);
});

// ---------------------------------------------------------------------------
// 3. Real git histories
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'netlify-ignore-'));
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'master');
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const commit = (msg, files = {}) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    g('add', '-A');
    g('commit', '-q', '--allow-empty', '-m', msg);
    return g('rev-parse', 'HEAD').trim();
  };
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { dir, g, commit, git };
}

async function decideIn(repo, { live, commit }) {
  return decide({
    env: { COMMIT_REF: commit, CACHED_COMMIT_REF: '0'.repeat(40), URL: 'https://shevato.com' },
    git: repo.git,
    fetchText: async () => stamped(live),
  });
}

test('real histories: inert-only changes since the live commit skip, anything else builds', async () => {
  const repo = makeRepo();
  try {
    const live = repo.commit('base', {
      'home.html': '<h1>home</h1>', 'assets/css/main.css': 'a{}', 'assets/js/extra.js': 'x()',
      'README.md': 'r', 'tests/static/a.test.mjs': 't', '.github/workflows/ci.yml': 'c', 'eslint.config.mjs': 'e',
    });

    const docs = repo.commit('docs', { 'README.md': 'r2', 'apps/arena/FINDINGS.md': 'f' });
    let r = await decideIn(repo, { live, commit: docs });
    assert.equal(r.build, false, r.reason);
    assert.deepEqual(r.paths.sort(), ['README.md', 'apps/arena/FINDINGS.md']);

    const ci = repo.commit('ci', { '.github/workflows/ci.yml': 'c2', 'tests/static/a.test.mjs': 't2', 'eslint.config.mjs': 'e2' });
    r = await decideIn(repo, { live, commit: ci });
    assert.equal(r.build, false, 'workflow, tests and lint config since the live commit: ' + r.reason);

    const empty = repo.commit('empty');
    r = await decideIn(repo, { live: ci, commit: empty });
    assert.equal(r.build, false, 'an identical tree deploys an identical site');

    const css = repo.commit('css', { 'assets/css/main.css': 'a{color:red}' });
    const docsAfterCss = repo.commit('docs after css', { 'README.md': 'r3' });
    r = await decideIn(repo, { live, commit: docsAfterCss });
    assert.equal(r.build, true, 'a CSS change the live site never received still builds, even under a docs-only tip');
    assert.deepEqual(r.paths, ['assets/css/main.css']);

    r = await decideIn(repo, { live: css, commit: docsAfterCss });
    assert.equal(r.build, false, 'once production serves the CSS, the docs commit on top is inert');

    r = await decideIn(repo, { live: docsAfterCss, commit: docsAfterCss });
    assert.equal(r.build, true, 'rebuilding the live commit is deliberate');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('THE RENAME TRAP: a published file moved into tests/ builds', async () => {
  const repo = makeRepo();
  try {
    const live = repo.commit('base', { 'assets/js/extra.js': 'export const x = 1;\n'.repeat(20) });
    mkdirSync(join(repo.dir, 'tests/static'), { recursive: true }); // git mv does not create the destination directory
    repo.g('mv', 'assets/js/extra.js', 'tests/static/extra.js');
    const moved = repo.commit('move');
    // What rename detection would have shown: only the inert-looking new name.
    const withRenames = repo.git(['diff', '--name-only', live, moved]).trim();
    assert.equal(withRenames, 'tests/static/extra.js', 'precondition: git detects this as a rename');
    const r = await decideIn(repo, { live, commit: moved });
    assert.equal(r.build, true, r.reason);
    assert.ok(r.paths.includes('assets/js/extra.js'), 'the file that left the site must be named');
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('real histories: a live commit on another line of history builds', async () => {
  const repo = makeRepo();
  try {
    const base = repo.commit('base', { 'home.html': 'a', 'README.md': 'r' });
    repo.g('checkout', '-q', '-b', 'side');
    const side = repo.commit('side', { 'home.html': 'b' });
    repo.g('checkout', '-q', 'master');
    const docs = repo.commit('docs', { 'README.md': 'r2' });
    const r = await decideIn(repo, { live: side, commit: docs });
    assert.equal(r.build, true, r.reason);
    assert.match(r.reason, /not an ancestor/);
    assert.ok(base);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test('real histories: paths with spaces and non-ASCII names are read whole', async () => {
  const repo = makeRepo();
  try {
    const live = repo.commit('base', { 'README.md': 'r' });
    const notes = repo.commit('notes', { 'apps/arena/naïve notes.md': 'n' });
    let r = await decideIn(repo, { live, commit: notes });
    assert.equal(r.build, false, r.reason);
    assert.deepEqual(r.paths, ['apps/arena/naïve notes.md']);
    const image = repo.commit('image', { 'images/naïve pic.png': 'p' });
    r = await decideIn(repo, { live: notes, commit: image });
    assert.equal(r.build, true);
    assert.deepEqual(r.paths, ['images/naïve pic.png']);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. The inert classes against the build's real inputs
// ---------------------------------------------------------------------------

const RELATIVE_SPECIFIERS = [
  /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g,
];

function resolveModule(fromRel, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`]) {
    const abs = join(REPO_ROOT, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return null;
}

/** Every repo file reachable from `entries` through relative require/import. */
function closure(entries) {
  const seen = new Set();
  const unresolved = [];
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = read(rel);
    for (const re of RELATIVE_SPECIFIERS) {
      for (const m of src.matchAll(re)) {
        const target = resolveModule(rel, m[1]);
        if (target) queue.push(target);
        else unresolved.push(`${rel} -> ${m[1]}`);
      }
    }
  }
  return { files: [...seen], unresolved };
}

/** The node scripts netlify.toml's build command runs, resolved through npm run. */
function buildEntries() {
  const toml = read('netlify.toml');
  const command = /^\s*command\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  assert.ok(command, 'netlify.toml names a build command');
  const npmRun = /^npm run ([\w:.-]+)$/.exec(command);
  assert.ok(npmRun, `the build command is "npm run <script>", which this test knows how to follow (got "${command}")`);
  const script = JSON.parse(read('package.json')).scripts[npmRun[1]];
  assert.ok(script, `package.json defines ${npmRun[1]}`);
  return script.split('&&').map((segment) => {
    const tokens = segment.trim().split(/\s+/);
    assert.equal(tokens[0], 'node', `every build step is a node script this test can follow; extend it for "${segment.trim()}"`);
    const file = tokens.slice(1).find((t) => !t.startsWith('-'));
    assert.ok(file && existsSync(join(REPO_ROOT, file)), `build step "${segment.trim()}" names a file that exists`);
    return file;
  });
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0').filter(Boolean);
}

test('no inert class can be published, at any depth of any published tree', () => {
  const probes = [];
  for (const root of ROOT_DIRS) {
    probes.push(`${root}/NOTES.md`, `${root}/x/README.md`, `${root}/tests/a.js`, `${root}/x/test/a.js`,
      `${root}/x/e2e/a.mjs`, `${root}/x/tests-rules/a.mjs`);
  }
  for (const p of probes) {
    assert.equal(classifyPath(p).relevant, false, `${p} is expected to be inert`);
    assert.equal(published(p), false, `${p} is inert, so build-publish-dir.mjs must never publish it`);
  }
  // Only the ROOT .github/ is GitHub's configuration. A nested .github/ is
  // ordinary content nobody has proven inert, so it builds.
  for (const root of ROOT_DIRS) {
    assert.equal(classifyPath(`${root}/x/.github/a.yml`).relevant, true, `${root}/x/.github/a.yml must build`);
  }
});

test('every tracked file the rule treats as inert is unpublished', () => {
  const inert = trackedFiles().filter((f) => !classifyPath(f).relevant);
  assert.ok(inert.length > 100, `expected the test estate and docs to be inert, found ${inert.length}`);
  const leaked = inert.filter(published);
  assert.deepEqual(leaked, [], `published files the ignore rule would skip for:\n${leaked.join('\n')}`);
});

test('the build command never reaches an inert file', () => {
  const entries = buildEntries();
  assert.ok(entries.includes('scripts/build-publish-dir.mjs'), 'the publish step is part of the build');
  const { files, unresolved } = closure(entries);
  assert.deepEqual(unresolved, [], 'every relative import of a build script resolves');
  const reached = files.filter((f) => !classifyPath(f).relevant);
  assert.deepEqual(reached, [], `the build imports files a build would be skipped for:\n${reached.join('\n')}`);

  // A build script that NAMES such a path in a string could read it with fs.
  // Measured on 2026-09-14 the build sources name none (and an strace of a full
  // build:site read none), so any hit is new and must be looked at.
  const NAMES_INERT = /['"`][^'"`\n]*(?:\.md\b|(?:^|\/)(?:tests?|tests-rules|e2e)\/|\.github\/|eslint\.config)[^'"`\n]*['"`]/;
  const naming = files.filter((f) => NAMES_INERT.test(read(f)));
  assert.deepEqual(naming, [], `build scripts that name an inert path in a string:\n${naming.join('\n')}`);
});

test('the functions bundle never reaches an inert file', () => {
  const dir = 'netlify/functions';
  const entries = readdirSync(join(REPO_ROOT, dir))
    .filter((f) => /\.(m?js|cjs)$/.test(f))
    .map((f) => `${dir}/${f}`);
  assert.ok(entries.length >= 3, `found ${entries.length} functions`);
  const { files, unresolved } = closure(entries);
  assert.deepEqual(unresolved, [], 'every relative import of a function resolves');
  assert.ok(files.some((f) => !f.startsWith('netlify/')), 'precondition: functions import app code from outside netlify/');
  const reached = files.filter((f) => !classifyPath(f).relevant);
  assert.deepEqual(reached, [], `functions import files a build would be skipped for:\n${reached.join('\n')}`);
});

test('netlify.toml has no build input this script does not know about', () => {
  // Plugins, edge functions, included_files, a base directory or a context
  // override would each add inputs outside what the tests above follow. Adding
  // one is fine; it just has to come with a look at this rule.
  const toml = read('netlify.toml').split('\n').filter((l) => !/^\s*#/.test(l));
  const sections = [...new Set(toml.map((l) => /^\s*\[{1,2}([^\]]+)\]{1,2}\s*$/.exec(l)?.[1]).filter(Boolean))];
  assert.deepEqual(sections.filter((s) => !['build', 'build.environment', 'functions', 'dev', 'redirects', 'headers', 'headers.values'].includes(s)), [],
    'a new netlify.toml section can add build inputs: check scripts/netlify-ignore.mjs still knows every one, then extend this list');

  const block = (name) => {
    const start = toml.findIndex((l) => l.trim() === `[${name}]`);
    const rest = toml.slice(start + 1);
    const end = rest.findIndex((l) => /^\s*\[/.test(l));
    return (end === -1 ? rest : rest.slice(0, end)).map((l) => /^\s*([\w.-]+)\s*=\s*"?([^"]*)"?/.exec(l)).filter(Boolean);
  };
  const buildKeys = block('build');
  assert.deepEqual(buildKeys.map((k) => k[1]).filter((k) => !['command', 'functions', 'publish', 'ignore'].includes(k)), [],
    'a new [build] key can add build inputs');
  assert.deepEqual(block('functions').map((k) => k[1]).filter((k) => k !== 'node_bundler'), [],
    'a new [functions] key (included_files, external_node_modules) can add build inputs');
  for (const [, key, value] of buildKeys) {
    assert.equal(classifyPath(value.replace(/^\.\//, '')).relevant, true, `[build] ${key} = "${value}" must not point at an inert path`);
  }

  const ignore = buildKeys.find((k) => k[1] === 'ignore');
  if (ignore) {
    assert.equal(ignore[2], 'node ./scripts/netlify-ignore.mjs', 'the ignore command runs this script, and nothing else');
  }
});

test('the script runs where Netlify runs ignore commands: node builtins only, no npm packages', () => {
  // Netlify runs `ignore` on Node 18 without the repository's dependencies.
  for (const rel of ['scripts/netlify-ignore.mjs', 'scripts/build-publish-dir.mjs']) {
    const specs = [...read(rel).matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.ok(specs.length > 0, rel);
    const foreign = specs.filter((s) => !s.startsWith('node:') && s !== './build-publish-dir.mjs');
    assert.deepEqual(foreign, [], `${rel} imports something Netlify's ignore runtime may not have`);
  }
  assert.equal(published('scripts/netlify-ignore.mjs'), false, 'the script is tooling, not part of the site');
  assert.ok(relative(REPO_ROOT, SCRIPT) === 'scripts/netlify-ignore.mjs');
  assert.ok(INERT.length === 4, 'widening the inert classes needs the proofs above extended first');
});
