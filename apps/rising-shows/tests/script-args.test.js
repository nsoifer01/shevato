'use strict';

// CLI argument handling for the three pipeline scripts that write into the
// app tree (2026-08-22 audit, D6). Each used to treat ANY argument as a normal
// run: `split-data.js --help` rewrote data-index.json plus 34k detail files,
// `export-integrations.js --help` rewrote the tracked exports/ tree and
// `build-show-pages.js --help` started regenerating 34k pages. These tests run
// the real scripts inside a throwaway app tree that HAS a data.json (so a run
// that ignored the flag would write real output) and assert nothing appears.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const MANIFEST = path.join(__dirname, '..', '..', '..', 'assets', 'apps-manifest.json');
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// One season record is enough for every script to have real work to do.
const DATA = {
  builtAt: '2026-01-01T00:00:00.000Z',
  matches: [{
    seriesId: 'tt0000001', title: 'Probe', year: 2020, season: 1, genres: ['Drama'],
    language: 'en', seriesRating: 8, seriesVotes: 5000, avgRating: 8, firstRating: 7,
    lastRating: 9, minVotes: 50, shapes: ['rising'], confidence: { rising: 1 },
    episodes: [{ episode: 1, rating: 7, votes: 50 }, { episode: 2, rating: 8, votes: 50 }, { episode: 3, rating: 9, votes: 50 }],
  }],
};

function appTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-args-test-'));
  tmpDirs.push(dir);
  // Mirrors the repo layout (apps/<app>/scripts + a root assets/) because
  // render-footer.js resolves the apps manifest relative to the script dir.
  const app = path.join(dir, 'apps', 'rising-shows');
  fs.cpSync(SCRIPTS_DIR, path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.copyFileSync(MANIFEST, path.join(dir, 'assets', 'apps-manifest.json'));
  fs.writeFileSync(path.join(app, 'data.json'), JSON.stringify(DATA));
  fs.writeFileSync(path.join(app, 'finder-presets.json'), JSON.stringify({ presets: [] }));
  return app;
}

function snapshot(app) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else out.push(path.relative(app, full));
    }
  })(app);
  return out.sort();
}

function run(app, script, args) {
  return spawnSync(process.execPath, [path.join(app, 'scripts', script), ...args], {
    cwd: app, encoding: 'utf8', timeout: 20000,
  });
}

const SCRIPTS = ['split-data.js', 'export-integrations.js', 'build-show-pages.js'];

for (const script of SCRIPTS) {
  test(`${script} --help prints usage and writes nothing`, () => {
    const app = appTree();
    const before = snapshot(app);
    for (const flag of ['--help', '-h']) {
      const r = run(app, script, [flag]);
      assert.equal(r.status, 0, `${flag}: exit ${r.status} stderr=${r.stderr}`);
      assert.match(r.stdout, /^Usage: node /, `${flag}: stdout=${r.stdout}`);
    }
    assert.deepEqual(snapshot(app), before, 'the app tree must be untouched');
  });

  test(`${script} rejects an unknown argument without running`, () => {
    const app = appTree();
    const before = snapshot(app);
    const r = run(app, script, ['--bogus']);
    assert.equal(r.status, 2, `exit ${r.status} stdout=${r.stdout}`);
    assert.match(r.stderr, /Unknown argument: --bogus/);
    assert.deepEqual(snapshot(app), before, 'the app tree must be untouched');
  });
}

// --only=<seriesId> exists for CI, which needs ONE built show page for the
// browser suite and not the full ~34k-page build on every shard. It must write
// that page and nothing else, and the page must be the one the full build
// writes, or the suite would be checking a page the site never serves.
test('build-show-pages.js --only writes exactly that show page, identical to the full build', () => {
  const { showPath } = require('../scripts/slugify.js');
  const rel = path.join('shows', showPath('Probe', 'tt0000001'), 'index.html');

  const one = appTree();
  const before = snapshot(one);
  const r = run(one, 'build-show-pages.js', ['--only=tt0000001']);
  assert.equal(r.status, 0, `exit ${r.status} stderr=${r.stderr}`);
  assert.deepEqual(snapshot(one), [...before, rel].sort(),
    'only the one page may appear: no wipe, no index, no hubs, no sitemap');

  const full = appTree();
  const rf = run(full, 'build-show-pages.js', []);
  assert.equal(rf.status, 0, `full build: exit ${rf.status} stderr=${rf.stderr}`);
  assert.equal(fs.readFileSync(path.join(one, rel), 'utf8'), fs.readFileSync(path.join(full, rel), 'utf8'));
});

test('build-show-pages.js --only refuses a malformed or unknown id without writing', () => {
  const app = appTree();
  const before = snapshot(app);
  const bad = run(app, 'build-show-pages.js', ['--only=breaking-bad']);
  assert.equal(bad.status, 2, `exit ${bad.status} stdout=${bad.stdout}`);
  assert.match(bad.stderr, /--only needs an IMDb series id/);
  const missing = run(app, 'build-show-pages.js', ['--only=tt9999999']);
  assert.equal(missing.status, 1, `exit ${missing.status} stdout=${missing.stdout}`);
  assert.match(missing.stderr, /no series with that id/);
  assert.deepEqual(snapshot(app), before, 'the app tree must be untouched');
});

// The guard must not break the real run: no arguments still does the job.
test('split-data.js with no arguments still writes the index (guard is argument-gated)', () => {
  const app = appTree();
  const r = run(app, 'split-data.js', []);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(app, 'data-index.json')));
  assert.ok(fs.existsSync(path.join(app, 'data', 'detail', 'tt0000001.json')));
});
