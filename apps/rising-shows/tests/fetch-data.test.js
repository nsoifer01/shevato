'use strict';

// F13 (2026-09-05 audit): a build must resolve to an EXACT approved dataset.
//
// fetch-data.js used to download two fixed urls from a rolling release that
// the refresh workflow overwrites with --clobber. Three things followed, and
// all three were real:
//
//   1. No build could ask for a particular dataset. Any deploy - a docs fix, a
//      rollback to last week's commit - picked up whatever was on the release
//      at that minute, including data whose review PR had not merged. The
//      workflow's own "nothing deploys until this PR merges" was true of the
//      derived files and false of the data.
//   2. The two files could come from different refreshes: they are uploaded
//      one after another, and a build starting in between gets one of each.
//   3. `skip if it exists` applied per file, so one stale local file and one
//      fresh download silently mixed two releases.
//
// The script now resolves a COMMITTED manifest (data-release.json), asks for
// release-stamped asset names, verifies the SHA-256 of both halves before
// either reaches disk, and treats a half-present pair as absent.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'fetch-data.js');
const APP_DIR = path.join(__dirname, '..');
const { immutableName } = require(SCRIPT);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('immutableName stamps the release before the extension, not after', () => {
  assert.equal(immutableName('data.json.gz', '20260907-120000-abc1234'),
    'data-20260907-120000-abc1234.json.gz');
  assert.equal(immutableName('show-modal-extras.json.gz', '20260907-120000-abc1234'),
    'show-modal-extras-20260907-120000-abc1234.json.gz');
});

// The download path is exercised by running the real script in a child
// process against a local HTTP server standing in for the GitHub release, in
// a throwaway copy of the app directory. Nothing here touches the network.
async function withFakeRelease(t, { assets, manifest, seed = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-fetch-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });

  const requests = [];
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    const name = req.url.replace(/^.*\//, '');
    requests.push(name);
    if (!Object.prototype.hasOwnProperty.call(assets, name)) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200); res.end(assets[name]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/rel`;

  // The script with its release base repointed at the local server.
  const src = fs.readFileSync(SCRIPT, 'utf8').replace(
    /const RELEASE_BASE =\n\s*'[^']*';/,
    `const RELEASE_BASE = ${JSON.stringify(base)};`
  );
  assert.ok(src.includes(base), 'the release base was repointed');
  fs.writeFileSync(path.join(dir, 'scripts', 'fetch-data.js'), src);
  if (manifest) {
    fs.writeFileSync(path.join(dir, 'data-release.json'), JSON.stringify(manifest, null, 2));
  }
  for (const [rel, body] of Object.entries(seed)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }

  // ASYNC, and that is load-bearing: execFileSync blocks this process's event
  // loop, so the local HTTP server standing in for the release could never
  // answer the child's request and the whole file deadlocked until the test
  // timeout.
  const run = async (args = []) => {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath, [path.join(dir, 'scripts', 'fetch-data.js'), ...args],
        { encoding: 'utf8' }
      );
      return { ok: true, out: stdout + stderr };
    } catch (err) {
      return { ok: false, out: String(err.stdout || '') + String(err.stderr || '') };
    }
  };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(dir, rel));
  return { dir, run, read, exists, requests };
}

const DATA = JSON.stringify({ contentHash: 'v1', series: [{ id: 1 }] });
const EXTRAS = JSON.stringify({ 'tt1': { cast: [] } });
const gz = (s) => zlib.gzipSync(Buffer.from(s));

function releaseWithPin(overrides = {}) {
  const id = '20260907-120000-abc1234';
  const dataGz = gz(DATA);
  const extrasGz = gz(EXTRAS);
  return {
    id,
    assets: {
      [immutableName('data.json.gz', id)]: dataGz,
      [immutableName('show-modal-extras.json.gz', id)]: extrasGz,
      'data.json.gz': dataGz,
      'show-modal-extras.json.gz': extrasGz,
      ...(overrides.assets || {}),
    },
    manifest: {
      releaseId: id,
      builtAt: '2026-09-07T12:00:00Z',
      assets: {
        'data.json.gz': { sha256: sha256(dataGz), bytes: dataGz.length },
        'show-modal-extras.json.gz': { sha256: sha256(extrasGz), bytes: extrasGz.length },
      },
      ...(overrides.manifest || {}),
    },
  };
}

test('F13: a pinned build asks for the release-stamped assets, not the rolling ones', async (t) => {
  const rel = releaseWithPin();
  const h = await withFakeRelease(t, { assets: rel.assets, manifest: rel.manifest });
  const r = await h.run();
  assert.ok(r.ok, r.out);
  assert.deepEqual(h.requests, [
    immutableName('data.json.gz', rel.id),
    immutableName('show-modal-extras.json.gz', rel.id),
  ]);
  assert.equal(h.read('data.json'), DATA);
  assert.equal(h.read('data/show-modal-extras.json'), EXTRAS);
});

test('F13: a checksum mismatch fails the build instead of shipping the wrong data', async (t) => {
  const rel = releaseWithPin();
  rel.manifest.assets['data.json.gz'].sha256 = 'f'.repeat(64);
  const h = await withFakeRelease(t, { assets: rel.assets, manifest: rel.manifest });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.match(r.out, /does not match the committed release manifest/);
  assert.equal(h.exists('data.json'), false, 'and nothing was written');
});

test('F13: the SECOND file failing leaves the FIRST unwritten', async (t) => {
  // Both halves are fetched and verified before either lands, so a failure
  // half way through cannot leave a mixed pair on disk.
  const rel = releaseWithPin();
  rel.manifest.assets['show-modal-extras.json.gz'].sha256 = 'a'.repeat(64);
  const h = await withFakeRelease(t, { assets: rel.assets, manifest: rel.manifest });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.equal(h.exists('data.json'), false);
  assert.equal(h.exists('data/show-modal-extras.json'), false);
});

test('F13: a pinned release missing its immutable assets falls back, still verified', async (t) => {
  // An older commit whose release assets have been pruned. The rolling names
  // may be a LATER refresh, so the digests decide: matching means the same
  // bytes and the build is correct; not matching is a hard stop.
  const rel = releaseWithPin();
  delete rel.assets[immutableName('data.json.gz', rel.id)];
  delete rel.assets[immutableName('show-modal-extras.json.gz', rel.id)];
  const h = await withFakeRelease(t, { assets: rel.assets, manifest: rel.manifest });
  const r = await h.run();
  assert.ok(r.ok, r.out);
  assert.equal(h.read('data.json'), DATA);

  const moved = releaseWithPin();
  delete moved.assets[immutableName('data.json.gz', moved.id)];
  moved.assets['data.json.gz'] = gz(JSON.stringify({ contentHash: 'v2' }));
  const h2 = await withFakeRelease(t, { assets: moved.assets, manifest: moved.manifest });
  const r2 = await h2.run();
  assert.equal(r2.ok, false, 'a rolling asset that has moved on is refused, not silently used');
  assert.match(r2.out, /does not match the committed release manifest/);
});

test('F13: no pin means the old behaviour, and it says so', async (t) => {
  const rel = releaseWithPin();
  const h = await withFakeRelease(t, { assets: rel.assets, manifest: null });
  const r = await h.run();
  assert.ok(r.ok, r.out);
  assert.deepEqual(h.requests, ['data.json.gz', 'show-modal-extras.json.gz']);
  assert.match(r.out, /no data-release\.json/);
  assert.equal(h.read('data.json'), DATA);
});

test('F13: one stale local file plus one fresh download can no longer mix releases', async (t) => {
  const rel = releaseWithPin();
  const h = await withFakeRelease(t, {
    assets: rel.assets,
    manifest: rel.manifest,
    seed: { 'data.json': JSON.stringify({ contentHash: 'LAST-WEEK' }) },
  });
  const r = await h.run();
  assert.ok(r.ok, r.out);
  assert.match(r.out, /re-downloading the whole pair/);
  assert.equal(h.read('data.json'), DATA, 'the stale half is replaced, not kept');
  assert.equal(h.read('data/show-modal-extras.json'), EXTRAS);
});

test('F13: a complete local pair is still left alone', async (t) => {
  const rel = releaseWithPin();
  const h = await withFakeRelease(t, {
    assets: rel.assets,
    manifest: rel.manifest,
    seed: { 'data.json': DATA, 'data/show-modal-extras.json': EXTRAS },
  });
  const r = await h.run();
  assert.ok(r.ok, r.out);
  assert.deepEqual(h.requests, [], 'no download at all');
  assert.match(r.out, /already exist/);
});

test('F13: an interrupted publication (one asset on the release) is a hard stop', async (t) => {
  const rel = releaseWithPin();
  delete rel.assets[immutableName('show-modal-extras.json.gz', rel.id)];
  delete rel.assets['show-modal-extras.json.gz'];
  const h = await withFakeRelease(t, { assets: rel.assets, manifest: rel.manifest });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.match(r.out, /Neither the immutable nor the rolling name/);
  assert.equal(h.exists('data.json'), false, 'and the half it DID get is not written');
});

test('F13: a corrupt download is refused before it can replace a good file', async (t) => {
  const rel = releaseWithPin();
  const truncated = gz(DATA).subarray(0, 20);
  rel.assets[immutableName('data.json.gz', rel.id)] = truncated;
  rel.assets['data.json.gz'] = truncated;
  rel.manifest.assets['data.json.gz'].sha256 = sha256(truncated);
  const h = await withFakeRelease(t, { assets: rel.assets, manifest: rel.manifest });
  const r = await h.run();
  assert.equal(r.ok, false, 'a digest-matching but unusable payload still fails');
  assert.equal(h.exists('data.json'), false);
});

test('F13: the committed manifest, when present, has the shape the script expects', () => {
  // The repo may legitimately not have one yet (the first refresh under the
  // new workflow writes it). When it does, it must be readable.
  const p = path.join(APP_DIR, 'data-release.json');
  if (!fs.existsSync(p)) return;
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(typeof m.releaseId, 'string');
  assert.ok(m.releaseId.length > 0);
  for (const asset of ['data.json.gz', 'show-modal-extras.json.gz']) {
    assert.match(m.assets[asset].sha256, /^[0-9a-f]{64}$/, asset);
    assert.ok(Number.isInteger(m.assets[asset].bytes) && m.assets[asset].bytes > 0, asset);
  }
});
