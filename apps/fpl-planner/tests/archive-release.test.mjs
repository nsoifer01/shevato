// The deadline archive's GitHub side (scripts/lib/archive-release.mjs) and the
// retrying fetch under it (scripts/lib/archive.mjs fetchWithRetry), hermetic.
//
// WHY THESE TESTS (2026-11-13, after run 43330644438 failed on one dropped
// connection). The release is the season's permanent record, so the properties
// that matter are about what happens when things go wrong half way: nothing
// archived is ever replaced or forgotten, a run that died is finished by the
// next one, a transient failure is retried and a permanent one is loud, and a
// healthy run moves no bytes it does not have to. Each `round` below is the
// library's copy sequence (readRelease, pullStaged, loadManifest, syncRelease)
// against a fake `gh` release that keeps real bytes and the REAL staged export
// handler (netlify/functions/fpl-archive-export.mjs) behind a fetch that can
// fail on cue. The expected states come from the scenario itself (which
// snapshots exist where), never from re-running the code.
//
// A `round` is not the whole production run: it leaves out FPL's bootstrap,
// which archive-snapshot.mjs read FIRST, so these tests could not see the
// 2026-11-23 failure (run 45087799507: one 403 on the bootstrap, nothing
// copied). The scenarios at the end call `runArchive`
// (scripts/lib/archive-run.mjs), the function the script runs, with a fake FPL
// as well.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildRecord, encodeRecord, snapshotFileName, emptyManifest, addToManifest, fetchWithRetry, retryAfterMs, fetchEndpoint, assertAppendOnly,
  FPL_API, decodeRecord,
} from '../scripts/lib/archive.mjs';
import {
  readRelease, pullStaged, loadManifest, syncRelease, planStagedPull, entryKey, indexWrites, MANIFEST, MANIFEST_COPIES,
} from '../scripts/lib/archive-release.mjs';
import { runArchive, exitCodeFor, newestStagedSeason } from '../scripts/lib/archive-run.mjs';
import { handleExport } from '../../../netlify/functions/fpl-archive-export.mjs';

const SEASON = '2026-27';
const TAG = 'fpl-archive-2026-27';
const BASE = 'https://shevato.test/.netlify/functions/fpl-archive-export';
const T0 = Date.parse('2026-11-01T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const noSleep = { sleep: async () => {}, random: () => 0 };

/* ---------------------------------------------------------------- snapshots */

/** One real archive record: its manifest entry and its gzip bytes. */
function snap(n, { endpoint = 'bootstrap', phase = 'pre', gw = 11, payload = { n } } = {}) {
  const capturedAt = iso(T0 + n * 60e3);
  const raw = JSON.stringify(payload);
  const record = buildRecord({ endpoint, url: `https://fpl.test/${endpoint}`, phase, gw, deadline: null, capturedAt, serverDate: null, season: SEASON, raw });
  const gz = encodeRecord(record);
  const file = snapshotFileName({ phase, gw, capturedAt, endpoint });
  return { file, gz, entry: { file, captureId: `${phase}-${n}`, endpoint, phase, gw, deadline: null, capturedAt, serverDate: null, url: record.url, sha256: record.sha256, bytes: record.bytes, gzBytes: gz.length } };
}

function manifestOf(snaps) {
  let m = emptyManifest(SEASON);
  for (const s of snaps) ({ manifest: m } = addToManifest(m, s.entry));
  return m;
}
const bytesOf = (m) => Buffer.from(`${JSON.stringify(m, null, 2)}\n`);

/* --------------------------------------------------------- the fake release */

/**
 * A GitHub release behind a `gh` with the CLI's real semantics (each one
 * measured against gh 2.4.0 and 2.104.0 on a real release, 2026-11-13):
 * no-clobber uploads refuse an existing name, --clobber deletes before it
 * uploads, a missing release is "release not found", an asset is stored under
 * its file's own name. `faults` fail calls on cue:
 * { when(args) -> bool, times, error, effect: 'none' | 'land' | 'delete', kill }.
 * A fault with `kill` ends the run there: the call's effect happens (or not),
 * and every later call of that run fails, as when a runner is cancelled.
 * Seeded as production is after its first run under this code: the index and
 * both copies hold the same manifest (`copies: false` is production before).
 */
function fakeRelease({ exists = true, snaps = [], manifest = undefined, extra = {}, copies = true } = {}) {
  const assets = new Map();
  for (const s of snaps) assets.set(s.file, { buf: s.gz, state: 'uploaded' });
  for (const [name, a] of Object.entries(extra)) assets.set(name, { state: 'uploaded', ...a });
  const m = manifest === undefined ? (snaps.length ? manifestOf(snaps) : null) : manifest;
  if (m) for (const name of copies ? [MANIFEST, ...MANIFEST_COPIES] : [MANIFEST]) assets.set(name, { buf: bytesOf(m), state: 'uploaded' });
  const rel = { exists, assets, calls: [], faults: [], dead: false };
  const fault = (args, run) => {
    if (rel.dead) throw new Error(`gh ${args.join(' ')} failed: the runner was cancelled`);
    const f = rel.faults.find((x) => x.times > 0 && x.when(args));
    if (!f) return run();
    f.times--;
    if (f.effect === 'land' || f.effect === 'delete') run(f.effect);
    if (f.kill) rel.dead = true;
    throw new Error(`gh ${args.join(' ')} failed: ${f.error}`);
  };
  rel.gh = (args) => {
    rel.calls.push(args);
    const [, verb, tag] = args;
    assert.equal(tag, TAG);
    return fault(args, (effect) => {
      if (verb === 'create') { rel.exists = true; return ''; }
      if (!rel.exists) throw new Error('gh release failed: release not found');
      if (verb === 'view') return JSON.stringify({ assets: [...assets].map(([name, a]) => ({ name, size: a.buf ? a.buf.length : 0, state: a.state })) });
      if (verb === 'download') {
        const name = args[args.indexOf('--pattern') + 1];
        const a = assets.get(name);
        if (!a) throw new Error('gh release download failed: no assets match the file pattern');
        writeFileSync(join(args[args.indexOf('--dir') + 1], name), a.buf);
        return '';
      }
      if (verb === 'upload') {
        const clobber = args.includes('--clobber');
        const paths = args.slice(3).filter((a) => a !== '--clobber');
        const dupes = paths.map((p) => basename(p)).filter((n) => assets.has(n));
        if (dupes.length && !clobber) throw new Error(`asset under the same name already exists: [${dupes.join(' ')}]`);
        for (const p of paths) {
          const name = basename(p);
          if (clobber) assets.delete(name);
          if (effect === 'delete') continue; // deleted, then the upload died
          assets.set(name, { buf: readFileSync(p), state: 'uploaded' });
        }
        return '';
      }
      throw new Error(`fake gh: unknown ${args.join(' ')}`);
    });
  };
  rel.writes = () => rel.calls.filter((a) => a[1] === 'upload' || a[1] === 'create');
  rel.index = (name) => (assets.has(name) ? JSON.parse(assets.get(name).buf.toString('utf8')) : null);
  rel.manifest = () => rel.index(MANIFEST);
  return rel;
}

/* ----------------------------------------------------- the staged side (real) */

/** The real export handler over an in-memory store, behind a fetch that can fail on cue. */
function stagedSite(snaps) {
  const map = new Map();
  if (snaps) {
    map.set(`${SEASON}/manifest.json`, JSON.stringify(manifestOf(snaps)));
    for (const s of snaps) map.set(`${SEASON}/${s.file}`, s.gz);
  }
  const store = {
    async get(key, { type } = {}) {
      if (!map.has(key)) return null;
      const v = map.get(key);
      if (type === 'json') return JSON.parse(String(v));
      if (type === 'arrayBuffer') { const b = Buffer.from(v); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      return v;
    },
    async getWithMetadata(key, opts) { const data = await this.get(key, opts); return data == null ? null : { data, etag: 'e1' }; },
    async list() { return { blobs: [], directories: map.size ? [`${SEASON}/`] : [] }; },
  };
  const site = { map, calls: [], faults: [] };
  site.fetchImpl = async (url, init) => {
    site.calls.push(url);
    const f = site.faults.find((x) => x.times > 0 && x.when(url));
    if (f) { f.times--; return f.respond(url, init); }
    return handleExport(new Request(url), store);
  };
  site.fileCalls = () => site.calls.filter((u) => u.includes('&file='));
  return site;
}

/* ------------------------------------------------------------------ a round */

const dirs = [];
const workDir = () => { const d = mkdtempSync(join(tmpdir(), 'archive-release-test-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * One workflow run, the production sequence archive-snapshot.mjs runs, with no
 * capture of its own (the gate is tests/archive.test.mjs's business). A fresh
 * directory every time, as on a runner.
 */
async function round(rel, site, { dir = workDir(), net = {}, retry = {} } = {}) {
  const release = await readRelease({ tag: TAG, gh: rel.gh, retry: { ...noSleep, ...retry } });
  const pulled = await pullStaged({ season: SEASON, dir, base: BASE, remote: release.manifest, fetchImpl: site.fetchImpl, net: { ...noSleep, ...net } });
  const manifest = loadManifest({ season: SEASON, dir, release });
  const synced = await syncRelease({ tag: TAG, season: SEASON, dir, manifest, release, gh: rel.gh, retry: { ...noSleep, ...retry } });
  return { release, pulled, manifest, synced, dir };
}

/** Every snapshot in `snaps` is on the release, byte for byte, and listed once. */
function assertArchived(rel, snaps) {
  const m = rel.manifest();
  assert.ok(m, 'the release has a manifest');
  const keys = m.entries.map(entryKey);
  assert.equal(new Set(keys).size, keys.length, 'no entry is listed twice');
  for (const s of snaps) {
    assert.ok(keys.includes(entryKey(s.entry)), `${s.file} is listed`);
    const stored = m.entries.find((e) => entryKey(e) === entryKey(s.entry));
    const file = stored.file || stored.sameAs;
    assert.ok(rel.assets.has(file), `${file} is on the release`);
    // A pointer's bytes are an earlier snapshot's; a stored file's are its own.
    if (stored.file) assert.ok(rel.assets.get(file).buf.equals(s.gz), `${file} is byte-identical`);
  }
}

const A = snap(1); const B = snap(2, { endpoint: 'fixtures' }); const C = snap(3); const D = snap(4); const E = snap(5, { endpoint: 'fixtures' });

/* -------------------------------------------------------- 1-3, 12, 15: plan */

test('1. everything staged is already archived: one manifest request, no file downloads, no writes', async () => {
  const rel = fakeRelease({ snaps: [A, B, C] });
  const site = stagedSite([A, B, C]);
  const before = rel.manifest();
  const r = await round(rel, site);
  assert.deepEqual(site.calls, [`${BASE}?season=${SEASON}`]);
  assert.deepEqual(r.pulled.needed, []);
  assert.deepEqual(rel.writes(), []);
  assert.deepEqual(rel.manifest(), before);
});

test('a staged capture whose bytes the release already stores becomes a pointer and is not downloaded', async () => {
  // The real release holds two of these (live GW5, post GW7 event-status):
  // GitHub stored the payload first, Netlify staged the same bytes later.
  const same = snap(9, { payload: { n: 1 } }); // A's payload, captured later
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([same]);
  const r = await round(rel, site);
  assert.deepEqual(site.fileCalls(), []);
  const entry = rel.manifest().entries.find((e) => entryKey(e) === entryKey(same.entry));
  assert.equal(entry.file, null);
  assert.equal(entry.sameAs, A.file);
  assert.deepEqual(r.synced.uploaded, []);
});

test('2. one new staged snapshot: exactly one download, one snapshot upload, one manifest upload', async () => {
  const rel = fakeRelease({ snaps: [A, B] });
  const site = stagedSite([A, B, C]);
  const r = await round(rel, site);
  assert.deepEqual(site.fileCalls(), [`${BASE}?season=${SEASON}&file=${C.file}`]);
  assert.deepEqual(r.synced.uploaded, [C.file]);
  const uploads = rel.writes().map((a) => a.slice(3).map((p) => basename(p)));
  // The new index goes to a copy first, then to manifest.json.
  assert.deepEqual(uploads, [[C.file], ['manifest.copy-1.json', '--clobber'], ['manifest.json', '--clobber']]);
  assert.deepEqual(rel.index('manifest.copy-1.json'), rel.manifest());
  assertArchived(rel, [A, B, C]);
});

test('3. several new snapshots, onto a release that does not exist yet: all archived, the release created once', async () => {
  const rel = fakeRelease({ exists: false });
  const site = stagedSite([A, B, C, D]);
  await round(rel, site);
  assert.equal(rel.writes().filter((a) => a[1] === 'create').length, 1);
  assert.equal(site.fileCalls().length, 4);
  assertArchived(rel, [A, B, C, D]);
});

test('12, 15. repeated runs change nothing and keep every earlier snapshot byte for byte', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B, C]);
  await round(rel, site);
  const after1 = new Map([...rel.assets].map(([k, v]) => [k, Buffer.from(v.buf)]));
  const writes1 = rel.writes().length;
  for (let i = 0; i < 3; i++) await round(rel, site);
  assert.equal(rel.writes().length, writes1, 'no further writes');
  assert.equal(site.fileCalls().length, 2, 'B and C downloaded once, in the first run only');
  for (const [k, v] of after1) assert.ok(rel.assets.get(k).buf.equals(v), `${k} unchanged`);
  assertArchived(rel, [A, B, C]);
});

test('the pull plan is exactly the staged entries the release neither lists nor stores', () => {
  const remote = manifestOf([A, B]);
  const staged = manifestOf([A, B, C, snap(10, { payload: { n: 2 }, endpoint: 'fixtures' }), D]);
  assert.deepEqual(planStagedPull({ staged, remote }).map((x) => x.file), [C.file, D.file]);
  assert.deepEqual(planStagedPull({ staged, remote: null }).map((x) => x.file), [A.file, B.file, C.file, D.file]);
  assert.deepEqual(planStagedPull({ staged: remote, remote }), []);
});

/* --------------------------------------------------- 4-8: network recovery */

const once = (when, respond, times = 1) => ({ when, respond, times });
const isFile = (f) => (u) => u.endsWith(`&file=${f.file}`);
const dropped = () => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); throw e; };

test('4. a dropped connection on a staged file is retried and the run completes (the 2026-11-12 failure)', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B, C]);
  site.faults.push(once(isFile(C), dropped));
  const sleeps = [];
  const warnings = [];
  await round(rel, site, { net: { sleep: async (ms) => { sleeps.push(ms); }, onRetry: (m) => warnings.push(m) } });
  assert.equal(site.fileCalls().filter((u) => u.endsWith(C.file)).length, 2);
  assert.deepEqual(sleeps, [2000]);
  assert.match(warnings[0], /network error: fetch failed \(ECONNRESET\); attempt 2 of 4/);
  assertArchived(rel, [A, B, C]);
});

test('5. a network that stays down gives up after four attempts, loudly, and the release is untouched', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B]);
  site.faults.push(once(isFile(B), dropped, 99));
  const before = rel.manifest();
  await assert.rejects(round(rel, site), /staged .*: network error: fetch failed \(ECONNRESET\) \(gave up after 4 attempts\)/);
  assert.equal(site.fileCalls().length, 4);
  assert.deepEqual(rel.writes(), []);
  assert.deepEqual(rel.manifest(), before);
});

test('6. 408, 429 and the transient 5xx are retried; Retry-After is honoured, as seconds or a date, and capped', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let n = 0;
    const fetchImpl = async () => (++n === 1 ? new Response('busy', { status }) : new Response('ok', { status: 200 }));
    const got = await fetchWithRetry('https://x.test/', { fetchImpl, ...noSleep });
    assert.equal(got.body, 'ok', `HTTP ${status} retried`);
    assert.equal(n, 2);
  }
  const waits = async (retryAfter) => {
    const sleeps = [];
    let n = 0;
    const fetchImpl = async () => (++n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': retryAfter } }) : new Response('ok'));
    await fetchWithRetry('https://x.test/', { fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
    return sleeps[0];
  };
  assert.equal(await waits('7'), 7000, 'delta-seconds longer than the backoff');
  assert.equal(await waits('1'), 2000, 'never shorter than the backoff');
  assert.equal(await waits('3600'), 20000, 'capped');
  assert.equal(retryAfterMs(new Date(T0 + 9000).toUTCString(), T0), 9000, 'an HTTP date');
  assert.equal(retryAfterMs('soon'), null);
});

test('7. a permanent status is final at once: no retry, a clear error', async () => {
  for (const status of [400, 401, 403, 404, 410, 501]) {
    let n = 0;
    const fetchImpl = async () => { n++; return new Response('no', { status }); };
    await assert.rejects(fetchWithRetry('https://x.test/', { label: 'thing', fetchImpl, ...noSleep }), (err) => {
      assert.equal(err.message, `thing: HTTP ${status} (body: "no")`);
      assert.equal(err.upstream, true);
      return true;
    });
    assert.equal(n, 1, `HTTP ${status} not retried`);
  }
  // A staged file the export does not have is a 404, final, never "nothing staged".
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B]);
  site.map.delete(`${SEASON}/${B.file}`);
  await assert.rejects(round(rel, site), new RegExp(`staged ${B.file}: HTTP 404`));
  assert.equal(site.fileCalls().length, 1);
});

test('8. a timeout and a transfer cut off half way are retried like a refused connection', async () => {
  let n = 0;
  const hang = async (url, init) => {
    // AbortSignal.timeout's timer does not hold the event loop open (a real
    // socket would), so this fake holds it for the length of the hang.
    if (++n === 1) {
      const hold = setTimeout(() => {}, 5000);
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => { clearTimeout(hold); reject(init.signal.reason); }));
    }
    return new Response('ok');
  };
  const got = await fetchWithRetry('https://x.test/', { fetchImpl: hang, timeoutMs: 20, ...noSleep });
  assert.equal(got.body, 'ok');
  assert.equal(n, 2);

  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B]);
  // Headers arrive, then the body dies: the read is inside the attempt.
  site.faults.push(once(isFile(B), () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => { throw new TypeError('terminated'); } })));
  await round(rel, site);
  assertArchived(rel, [A, B]);

  // The same for FPL itself: a body cut off mid-bootstrap is retried.
  let k = 0;
  const fpl = async () => (++k === 1
    ? { ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError('terminated'); } }
    : new Response(JSON.stringify([{ id: 1, team_h: 1, team_a: 2 }])));
  const fx = await fetchEndpoint('fixtures', 'fixtures/', { fetchImpl: fpl, ...noSleep });
  assert.equal(k, 2);
  assert.equal(fx.body.length, 1);
});

/* ------------------------------------------- 9: corrupted or wrong bytes */

test('9. a corrupted or mismatched staged file is refused, not retried, and nothing reaches the release', async () => {
  for (const bad of [B.gz.subarray(0, B.gz.length - 9), Buffer.from('<html>error</html>'), C.gz]) {
    const rel = fakeRelease({ snaps: [A] });
    const site = stagedSite([A, B]);
    site.map.set(`${SEASON}/${B.file}`, bad);
    const before = rel.manifest();
    await assert.rejects(round(rel, site), new RegExp(`staged ${B.file} (is not a valid archive record|does not match its manifest hash)`));
    assert.equal(site.fileCalls().length, 1, 'invalid data is not retried');
    assert.deepEqual(rel.writes(), []);
    assert.deepEqual(rel.manifest(), before);
  }
});

test('9. a local file that is not the snapshot its entry names is never uploaded', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B]);
  const dir = workDir();
  writeFileSync(join(dir, B.file), B.gz.subarray(0, 40)); // an earlier local run cut off mid-write
  await assert.rejects(round(rel, site, { dir }), new RegExp(`${B.file} on this machine is not a valid archive record`));
  assert.deepEqual(rel.writes(), []);
});

/* -------------------------------------- 10: release state it cannot trust */

test('10. a release that does not hold what its manifest lists stops the run before anything is written', async () => {
  const cases = [
    ['missing', (rel) => rel.assets.delete(B.file), /is not on the release/],
    ['wrong size', (rel) => { rel.assets.get(B.file).buf = Buffer.concat([B.gz, Buffer.from('x')]); }, /bytes, the manifest says/],
    ['not uploaded', (rel) => { rel.assets.get(B.file).state = 'starter'; }, /in state starter/],
    ['no index anywhere', (rel) => { for (const n of [MANIFEST, ...MANIFEST_COPIES]) rel.assets.delete(n); }, /no manifest\.json or copy of it, so its index was lost/],
    ['unreadable index', (rel) => { rel.assets.get('manifest.json').buf = Buffer.from('{"entr'); }, /manifest\.json that is not JSON/],
    ['unreadable copy', (rel) => { rel.assets.get('manifest.copy-2.json').buf = Buffer.from('<html>'); }, /manifest\.copy-2\.json that is not JSON/],
    ['copies that disagree', (rel) => { rel.assets.set('manifest.copy-1.json', { buf: bytesOf(manifestOf([A, C])), state: 'uploaded' }); }, /disagree .* compare them by hand/],
  ];
  for (const [name, damage, why] of cases) {
    const rel = fakeRelease({ snaps: [A, B] });
    damage(rel);
    const site = stagedSite([A, B, C]);
    await assert.rejects(round(rel, site), why, name);
    assert.deepEqual(rel.writes(), [], `${name}: nothing written`);
    assert.deepEqual(site.calls, [], `${name}: nothing pulled`);
  }
});

test('10. a failing `gh release view` is retried and never read as "the release does not exist"', async () => {
  const rel = fakeRelease({ snaps: [A] });
  rel.faults.push({ when: (a) => a[1] === 'view', times: 2, error: 'HTTP 502: Bad Gateway' });
  const r = await round(rel, stagedSite([A, B]));
  assert.equal(r.release.exists, true);
  assert.equal(rel.writes().filter((a) => a[1] === 'create').length, 0);
  assertArchived(rel, [A, B]);

  const down = fakeRelease({ snaps: [A] });
  down.faults.push({ when: (a) => a[1] === 'view', times: 99, error: 'HTTP 503: Service Unavailable' });
  await assert.rejects(round(down, stagedSite([A, B])), /HTTP 503/);
  assert.equal(down.calls.length, 4);
  assert.deepEqual(down.writes(), []);
});

/* ------------------------------------- 11, 14: interrupted and failed runs */

test('11. snapshots an interrupted run uploaded but never indexed are indexed from their own records', async () => {
  // The previous run uploaded B and C and died before the index. Neither is
  // staged (a capture the GitHub job made itself), so the release is the only
  // place their bytes exist.
  const rel = fakeRelease({ snaps: [A], extra: { [B.file]: { buf: B.gz }, [C.file]: { buf: C.gz } } });
  const site = stagedSite([A, D]);
  const r = await round(rel, site);
  assert.deepEqual(r.release.recovered, [B.file, C.file]);
  assert.deepEqual(r.release.orphans, []);
  assert.deepEqual(site.fileCalls(), [`${BASE}?season=${SEASON}&file=${D.file}`]);
  assert.deepEqual(r.synced.uploaded, [D.file]);
  assertArchived(rel, [A, B, C, D]);
  // Rebuilt from the record, every field but captureId (which the record does
  // not carry, and these test entries number differently) is what the
  // capture wrote.
  for (const s of [B, C]) {
    const e = rel.manifest().entries.find((x) => x.file === s.file);
    assert.deepEqual({ ...e, captureId: null, sameAs: undefined }, { ...s.entry, captureId: null, sameAs: undefined });
  }
  assert.deepEqual((await readRelease({ tag: TAG, gh: rel.gh })).orphans, []);

  // Staged as well: still indexed from the release, nothing downloaded.
  const rel2 = fakeRelease({ snaps: [A], extra: { [B.file]: { buf: B.gz } } });
  const site2 = stagedSite([A, B]);
  await round(rel2, site2);
  assert.deepEqual(site2.fileCalls(), []);
  assertArchived(rel2, [A, B]);
});

test('11. an asset of the same name with different bytes is a conflict: refused, nothing replaced, nothing indexed', async () => {
  const rel = fakeRelease({ snaps: [A], extra: { [B.file]: { buf: Buffer.from('something else') } } });
  const before = rel.manifest();
  await assert.rejects(round(rel, stagedSite([A, B])), new RegExp(`already holds a different ${B.file}; refusing to replace it`));
  assert.equal(rel.assets.get(B.file).buf.toString(), 'something else');
  assert.deepEqual(rel.manifest(), before);
});

test('11. a half-uploaded asset (state starter) is reported with what to do, not overwritten', async () => {
  const rel = fakeRelease({ snaps: [A], extra: { [B.file]: { buf: Buffer.alloc(0), state: 'starter' } } });
  await assert.rejects(round(rel, stagedSite([A, B])), /in state starter \(an interrupted upload\): delete that asset/);
  assert.deepEqual(rel.writes(), []);
});

test('14. a snapshot upload that fails, landed or not, is recovered without a duplicate or a replace', async () => {
  for (const effect of ['none', 'land']) {
    const rel = fakeRelease({ snaps: [A] });
    rel.faults.push({ when: (a) => a[1] === 'upload' && !a.includes('--clobber'), times: 1, error: 'HTTP 502: Bad Gateway', effect });
    const r = await round(rel, stagedSite([A, B]));
    assert.deepEqual([...r.synced.uploaded, ...r.synced.alreadyThere], [B.file], effect);
    assertArchived(rel, [A, B]);
  }
});

test('14. --clobber deleting the old manifest and then failing is retried until the release serves the new one', async () => {
  const rel = fakeRelease({ snaps: [A] });
  rel.faults.push({ when: (a) => a.includes('--clobber'), times: 2, error: 'HTTP 500: upload failed', effect: 'delete' });
  await round(rel, stagedSite([A, B]));
  assertArchived(rel, [A, B]);
});

test('14. uploads that keep failing end the run loudly; the next run, once GitHub is back, finishes the job', async () => {
  const rel = fakeRelease({ snaps: [A] });
  rel.faults.push({ when: (a) => a[1] === 'upload' && !a.includes('--clobber'), times: 99, error: 'HTTP 503' });
  await assert.rejects(round(rel, stagedSite([A, B, C])), /uploading .* failed after 4 attempts: .*HTTP 503/);
  assert.equal(rel.manifest().entries.length, 1, 'the index still lists only what is uploaded');
  rel.faults.length = 0;
  await round(rel, stagedSite([A, B, C]));
  assertArchived(rel, [A, B, C]);
});

test('14. a manifest.json replace that deletes it and never uploads is loud, and the next run restores it from the copy', async () => {
  const rel = fakeRelease({ snaps: [A] });
  rel.faults.push({ when: (a) => a.includes('--clobber') && a[3].endsWith('/manifest.json'), times: 99, error: 'HTTP 500', effect: 'delete' });
  await assert.rejects(round(rel, stagedSite([A, B])), /manifest\.json did not reach release .* after 4 attempts .* the next run restores manifest\.json from it/);
  assert.equal(rel.manifest(), null, 'gh deleted it');
  assert.deepEqual(rel.index('manifest.copy-1.json'), manifestOf([A, B]), 'the copy holds the new index');
  rel.faults.length = 0;
  const r = await round(rel, stagedSite([A, B]));
  assert.equal(r.release.restoredFrom, 'manifest.copy-1.json');
  assertArchived(rel, [A, B]);
  assert.deepEqual(rel.manifest(), manifestOf([A, B]));
});

test('14. a copy replace that deletes it and never uploads is loud, leaves manifest.json alone, and the next run finishes', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const before = rel.manifest();
  rel.faults.push({ when: (a) => a.includes('--clobber') && a[3].endsWith('/manifest.copy-1.json'), times: 99, error: 'HTTP 500', effect: 'delete' });
  await assert.rejects(round(rel, stagedSite([A, B])), /manifest\.copy-1\.json did not reach release .* manifest\.json was not touched/);
  assert.deepEqual(rel.manifest(), before);
  assert.deepEqual(rel.index('manifest.copy-2.json'), before);
  rel.faults.length = 0;
  await round(rel, stagedSite([A, B]));
  assertArchived(rel, [A, B]);
});

test('14. a release create that keeps failing is loud, and the next run creates it', async () => {
  const rel = fakeRelease({ exists: false });
  rel.faults.push({ when: (a) => a[1] === 'create', times: 99, error: 'HTTP 502' });
  await assert.rejects(round(rel, stagedSite([A])), /HTTP 502/);
  assert.equal(rel.exists, false);
  rel.faults.length = 0;
  await round(rel, stagedSite([A]));
  assertArchived(rel, [A]);
});

/* -------------------------------------------------------- 13: concurrency */

test('13. a manifest another run replaced while this one worked is not overwritten', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B]);
  const dir = workDir();
  const release = await readRelease({ tag: TAG, gh: rel.gh, retry: noSleep });
  await pullStaged({ season: SEASON, dir, base: BASE, remote: release.manifest, fetchImpl: site.fetchImpl, net: noSleep });
  const manifest = loadManifest({ season: SEASON, dir, release });
  // Meanwhile another run indexes C.
  const other = manifestOf([A, C]);
  rel.assets.set(C.file, { buf: C.gz, state: 'uploaded' });
  rel.assets.set('manifest.json', { buf: bytesOf(other), state: 'uploaded' });
  await assert.rejects(
    syncRelease({ tag: TAG, season: SEASON, dir, manifest, release, gh: rel.gh, retry: noSleep }),
    /manifest\.json changed while this run was working; nothing was replaced/,
  );
  assert.deepEqual(rel.manifest(), other);
  // The next run starts from the new index and keeps both.
  await round(rel, site);
  assertArchived(rel, [A, B, C]);
});

/* ------------------------------------------------- staged side edge cases */

test('nothing staged yet is a quiet no-op, and a staged manifest that is not one is an error', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const empty = await round(rel, stagedSite(null));
  assert.equal(empty.pulled.staged, null);
  assert.deepEqual(rel.writes(), []);
  const site = stagedSite([A]);
  site.map.set(`${SEASON}/manifest.json`, JSON.stringify({ nope: true }));
  await assert.rejects(round(rel, site), /staged manifest is malformed/);
});

test('the dry run reads but writes nothing', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B]);
  const dir = workDir();
  const release = await readRelease({ tag: TAG, gh: rel.gh, retry: noSleep });
  await pullStaged({ season: SEASON, dir, base: BASE, remote: release.manifest, fetchImpl: site.fetchImpl, net: noSleep });
  const printed = [];
  const dry = (args) => { if (args[1] === 'view' || args[1] === 'download') return rel.gh(args); printed.push(args); return ''; };
  const out = await syncRelease({ tag: TAG, season: SEASON, dir, manifest: loadManifest({ season: SEASON, dir, release }), release, gh: dry, dryRun: true, retry: noSleep });
  assert.deepEqual(out.uploaded, [B.file]);
  assert.deepEqual(printed.map((a) => basename(a[3])), [B.file, 'manifest.copy-1.json', 'manifest.json']);
  assert.deepEqual(rel.writes(), []);
  assert.ok(!rel.assets.has(B.file));
  assert.ok(existsSync(join(dir, B.file)) && readdirSync(dir).includes('manifest.json'));
});

/* ------------------------------------- the index copies, and every kill point */

test('the first run on a release with no copies (production before this change) writes one copy and nothing else', async () => {
  const rel = fakeRelease({ snaps: [A, B], copies: false });
  const before = Buffer.from(rel.assets.get(MANIFEST).buf);
  await round(rel, stagedSite([A, B]));
  assert.deepEqual(rel.writes().map((a) => basename(a[3])), ['manifest.copy-1.json']);
  assert.ok(rel.assets.get(MANIFEST).buf.equals(before), 'manifest.json is untouched');
  assert.deepEqual(rel.index('manifest.copy-1.json'), rel.manifest());
  await round(rel, stagedSite([A, B]));
  assert.equal(rel.writes().length, 1, 'and the next run writes nothing');
});

test('the copy replaced is always one the other two index assets cover', () => {
  // Oracle: whichever asset is about to be deleted, some asset left holds
  // every entry it held. Enumerated over each of the three being missing,
  // one entry behind, or current.
  const m0 = manifestOf([A]); const m1 = manifestOf([A, B]); const next = manifestOf([A, B, C]);
  const states = [null, m0, m1];
  for (const a of states) for (const b of states) for (const c of states) {
    const held = [a, b, c].filter(Boolean);
    if (!held.length) continue;
    const stored = { [MANIFEST]: a, [MANIFEST_COPIES[0]]: b, [MANIFEST_COPIES[1]]: c };
    const writes = indexWrites(stored, next);
    assert.equal(writes[writes.length - 1], MANIFEST, 'manifest.json is written, and written last');
    const after = { ...stored };
    for (const name of writes) {
      const victim = after[name];
      const others = Object.keys(after).filter((n) => n !== name).map((n) => after[n]).filter(Boolean);
      if (victim) assert.ok(others.some((o) => o.entries.length >= victim.entries.length), `replacing ${name} leaves its entries elsewhere`);
      if (name === MANIFEST) assert.ok(MANIFEST_COPIES.some((n) => JSON.stringify(after[n]) === JSON.stringify(next)), 'a copy holds the new index first');
      after[name] = next;
    }
  }
});

test('3, 11, 14. a run killed at any write, before, during or after it, is finished by the next run with nothing lost', async () => {
  // History on the release: A, B, and a pointer P (A's bytes, later). This
  // run has two staged captures (D, E, plus a staged pointer Q to B) and one
  // capture of its own, G, that exists only on this runner.
  const P = snap(6, { payload: { n: 1 } });
  const Q = snap(7, { endpoint: 'fixtures', payload: { n: 2 } });
  const G = snap(8, { endpoint: 'event-status' });
  const history = manifestOf([A, B, P]);
  const staged = [A, B, P, D, E, Q];
  const fresh = () => fakeRelease({ snaps: [A, B], manifest: history });
  const localG = () => {
    const dir = workDir();
    writeFileSync(join(dir, G.file), G.gz);
    writeFileSync(join(dir, MANIFEST), bytesOf(manifestOf([G])));
    return dir;
  };
  // The clean run's writes, in order: what a kill can interrupt.
  const clean = fresh();
  await round(clean, stagedSite(staged), { dir: localG() });
  const writes = clean.writes().map((a) => basename(a[3]));
  assert.deepEqual(writes, [G.file, D.file, E.file, 'manifest.copy-1.json', 'manifest.json']);
  assertArchived(clean, [A, B, P, D, E, Q, G]);

  let cases = 0;
  for (let k = 0; k < writes.length; k++) {
    const clobber = writes[k].startsWith('manifest');
    for (const effect of clobber ? ['none', 'delete', 'land'] : ['none', 'land']) {
      cases++;
      const rel = fresh();
      const snapshotsBefore = new Map([...rel.assets].filter(([n]) => !n.startsWith('manifest')).map(([n, a]) => [n, Buffer.from(a.buf)]));
      let seen = 0;
      rel.faults.push({ when: (a) => (a[1] === 'upload' || a[1] === 'create') && seen++ === k, times: 1, error: 'killed', effect, kill: true });
      await assert.rejects(round(rel, stagedSite(staged), { dir: localG() }));
      // G reached the release only if its upload landed before the kill.
      const gLanded = k > writes.indexOf(G.file) || (k === writes.indexOf(G.file) && effect === 'land');
      assert.equal(rel.assets.has(G.file), gLanded, `kill at ${writes[k]} (${effect}): G on the release`);

      // The next run: a fresh runner, so G's local file is gone.
      rel.dead = false;
      rel.faults.length = 0;
      await round(rel, stagedSite(staged));
      const label = `kill at ${writes[k]} (${effect})`;
      assertAppendOnly(history, rel.manifest());
      assertArchived(rel, gLanded ? [A, B, P, D, E, Q, G] : [A, B, P, D, E, Q]);
      for (const [n, buf] of snapshotsBefore) assert.ok(rel.assets.get(n).buf.equals(buf), `${label}: ${n} untouched`);
      const after = await readRelease({ tag: TAG, gh: rel.gh });
      assert.deepEqual(after.orphans, [], `${label}: nothing left unindexed`);
      assert.deepEqual(after.recovered, [], `${label}: nothing left to recover`);
      assert.equal(after.restoredFrom, null, `${label}: manifest.json is current`);
      assert.ok(MANIFEST_COPIES.some((n) => JSON.stringify(rel.index(n)) === JSON.stringify(rel.manifest())), `${label}: a copy matches`);
      // And it stays done.
      const writesBefore = rel.writes().length;
      await round(rel, stagedSite(staged));
      assert.equal(rel.writes().length, writesBefore, `${label}: a third run writes nothing`);
    }
  }
  assert.equal(cases, 3 * 2 + 2 * 3);
});

test('3. a run killed right after it created the release is finished by the next', async () => {
  for (const effect of ['none', 'land']) {
    const rel = fakeRelease({ exists: false });
    rel.faults.push({ when: (a) => a[1] === 'create', times: 1, error: 'killed', effect, kill: true });
    await assert.rejects(round(rel, stagedSite([A, B])));
    rel.dead = false;
    rel.faults.length = 0;
    await round(rel, stagedSite([A, B]));
    assertArchived(rel, [A, B]);
  }
});

test('a release of 99, 100, 101 or 420 assets is read whole; at 900 the run stops before writing', async () => {
  // gh lists every asset of a real release up to 900 (2.4.0 and 2.104.0,
  // measured 2026-11-13 on a temporary release): nothing here may assume a
  // page of 100.
  const many = Array.from({ length: 900 }, (_, i) => snap(100 + i, { payload: { i } }));
  for (const total of [99, 100, 101, 420, 900]) {
    // The index and its two copies are three of the assets.
    const snaps = many.slice(0, total - 3);
    const rel = fakeRelease({ snaps });
    assert.equal(rel.assets.size, total);
    if (total >= 900) {
      await assert.rejects(readRelease({ tag: TAG, gh: rel.gh }), /holds 900 assets, at the 900 safety line/);
      continue;
    }
    const got = await readRelease({ tag: TAG, gh: rel.gh });
    assert.equal(got.assets.size, total, `${total}: every asset listed`);
    assert.equal(got.manifest.entries.length, snaps.length, `${total}: every entry read`);
    assert.deepEqual(got.orphans, []);
    // Were a listing ever to come back as one page of 100, the files the
    // index names but the list lacks stop the run before anything is written.
    if (total > 100) {
      const short = fakeRelease({ snaps });
      const view = short.gh;
      short.gh = (args) => (args[1] === 'view' ? JSON.stringify({ assets: JSON.parse(view(args)).assets.slice(-100) }) : view(args));
      await assert.rejects(round(short, stagedSite(snaps)), /is not on the release/, `${total}: a truncated list is not accepted`);
      assert.deepEqual(short.writes(), []);
    }
  }
});

/* ------------------------------------------- the whole run, FPL included */

// The GW11 deadline is a week after the staged snapshots (T0), so by default
// nothing is due: GW10's deadline passed a week before, and GW10 is finished
// but not yet data_checked (no live capture owed). The bootstrap lists only
// those two gameweeks, so no older one owes a live capture either.
const GW10 = '2026-10-25T13:30:00Z';
const GW11 = Date.parse('2026-11-08T13:30:00Z');
const QUIET = iso(T0 + 3 * 3600e3);
// Inside GW11's final two hours, with only A (a pre capture a week old) staged:
// a pre capture Netlify did not take, which the gate must.
const FINAL = iso(GW11 - 1.5 * 3600e3);
// What FPL's Fastly edge sends with a refusal (headers as recorded on
// 2026-10-16, FINDINGS "FPL refused the proxy again").
const EDGE_403 = () => new Response('', { status: 403, headers: { via: '1.1 varnish', 'x-served-by': 'cache-iad-kiad7000100-IAD', 'x-cache': 'MISS' } });

/** A fake FPL that serves real-shaped payloads and fails on cue: faults are { when(path), times, respond() }. */
function fakeFpl({ checked = false } = {}) {
  const bootstrap = {
    elements: [{ id: 1, team: 1, element_type: 3, now_cost: 50, total_points: 0 }],
    teams: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })),
    events: [
      { id: 10, deadline_time: GW10, finished: true, data_checked: checked },
      { id: 11, deadline_time: iso(GW11), finished: false, data_checked: false },
    ],
  };
  const bodies = {
    'bootstrap-static/': bootstrap,
    'fixtures/': [{ id: 1, team_h: 1, team_a: 2 }],
    'event-status/': { status: [] },
    'event/10/live/': { elements: [{ id: 1, stats: { total_points: 2 } }] },
  };
  const fpl = { calls: [], faults: [] };
  fpl.fetch = async (url) => {
    const path = url.slice(FPL_API.length);
    fpl.calls.push(path);
    const f = fpl.faults.find((x) => x.times > 0 && x.when(path));
    if (f) { f.times--; return f.respond(path); }
    if (!(path in bodies)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(bodies[path]), { status: 200, headers: { date: new Date(T0).toUTCString() } });
  };
  return fpl;
}

/**
 * One production run: runArchive, as archive-snapshot.mjs calls it in the
 * workflow (--release --staged, auto unless a phase is given), against the
 * fake release, the real export over `site`, and `fpl`. `code` is what the
 * process would exit with, a throw included.
 */
async function run(rel, site, fpl, { now = QUIET, phase = 'auto', gw = null, sleeps = null } = {}) {
  const dir = workDir();
  const said = { warn: [], error: [], log: [] };
  let tick = Date.parse(now);
  const net = sleeps ? { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 } : noSleep;
  try {
    const result = await runArchive({
      out: dir, phase, gw, now, release: true, staged: BASE, gh: rel.gh,
      fetchImpl: (url, init) => (url.startsWith(FPL_API) ? fpl.fetch(url, init) : site.fetchImpl(url, init)),
      net, retry: noSleep,
      log: (m) => said.log.push(m), warn: (m) => said.warn.push(m), error: (m) => said.error.push(m),
      clock: () => iso(tick += 1000),
    });
    return { ...result, code: exitCodeFor({ phase, ...result }), said, dir };
  } catch (thrown) {
    // archive-snapshot.mjs's rejection handler.
    return { thrown, code: thrown.gameUpdating ? 75 : 1, said, dir };
  }
}

/** The release's entries of one phase and gameweek, by endpoint. */
const releaseCaptures = (rel, phase, gw) => rel.manifest().entries.filter((e) => e.phase === phase && e.gw === gw).map((e) => e.endpoint).sort();

test('R1. FPL refuses the bootstrap (the 2026-11-23 failure): everything staged is still copied, FPL is asked once, the run warns (75)', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B, C, D]);
  const fpl = fakeFpl();
  fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 99, respond: EDGE_403 });
  const r = await run(rel, site, fpl);
  assert.equal(r.thrown, undefined);
  assertArchived(rel, [A, B, C, D]);
  assert.equal(rel.manifest().entries.length, 4);
  // 403 is final at once: no retry of FPL, and no other FPL endpoint asked.
  assert.deepEqual(fpl.calls, ['bootstrap-static/']);
  assert.equal(r.code, 75);
  assert.equal(r.fplError.status, 403);
  assert.equal(r.summary.idle, 'FPL could not be read');
  // The warning names the edge that refused, which the 2026-11-23 log could not.
  assert.match(r.said.warn.join('\n'), /bootstrap: HTTP 403 \(via: 1\.1 varnish, x-served-by: cache-iad-kiad7000100-IAD, x-cache: MISS, body: ""\)/);
  // The season came from the export's own list, which was asked once.
  assert.equal(site.calls.filter((u) => u === BASE).length, 1);
});

test('R2. FPL keeps refusing across runs while Netlify keeps staging: every run copies what is new, nothing is lost or duplicated', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const fpl = fakeFpl();
  fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 99, respond: EDGE_403 });
  const staged = [A];
  for (const next of [B, C, D, E]) {
    staged.push(next);
    const r = await run(rel, stagedSite(staged), fpl);
    assert.equal(r.code, 75);
    assertArchived(rel, staged);
    assert.equal(rel.manifest().entries.length, staged.length);
  }
  assert.equal(fpl.calls.length, 4, 'one FPL request a run, never a retry storm');
  // And once FPL answers again, the run is clean and writes nothing more.
  const clean = await run(rel, stagedSite(staged), fakeFpl());
  assert.equal(clean.code, 0);
  assert.equal(rel.manifest().entries.length, staged.length);
});

test('R3. the release is already up to date and FPL refuses: no writes, a warning, not a failure', async () => {
  const rel = fakeRelease({ snaps: [A, B] });
  const fpl = fakeFpl();
  fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 1, respond: EDGE_403 });
  const r = await run(rel, stagedSite([A, B]), fpl);
  assert.equal(r.code, 75);
  assert.deepEqual(rel.writes(), []);
});

test('R4. FPL is updating, unreachable, or rate limiting past every retry: the copy still happens and the run warns (75)', async () => {
  const cases = {
    updating: () => new Response('The game is being updated.', { status: 503 }),
    unreachable: () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); },
    'rate limited': () => new Response('', { status: 429, headers: { 'retry-after': '5' } }),
  };
  for (const [name, respond] of Object.entries(cases)) {
    const rel = fakeRelease({ snaps: [A] });
    const fpl = fakeFpl();
    fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 99, respond });
    const r = await run(rel, stagedSite([A, B, C]), fpl);
    assert.equal(r.code, 75, name);
    assertArchived(rel, [A, B, C]);
    // The update notice is final at once; a network failure and a 429 are
    // asked four times, as every FPL read is.
    assert.equal(fpl.calls.length, name === 'updating' ? 1 : 4, name);
  }
});

test('R5. a rate limit that lifts is waited out (Retry-After honoured), and a body cut off half way is asked again: the run is clean', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const fpl = fakeFpl();
  fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 1, respond: () => new Response('', { status: 429, headers: { 'retry-after': '7' } }) });
  // Headers arrive, then the connection drops inside the body.
  fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 1, respond: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"elem')); c.error(new TypeError('terminated')); } }), { status: 200 }) });
  const sleeps = [];
  const r = await run(rel, stagedSite([A, B]), fpl, { sleeps });
  assert.equal(r.code, 0);
  assert.equal(r.fplError, null);
  assert.equal(sleeps[0], 7000, 'Retry-After, not the shorter backoff');
  assert.equal(fpl.calls.filter((p) => p === 'bootstrap-static/').length, 3);
  assertArchived(rel, [A, B]);
});

test('R6. a capture Netlify did not take becomes due: the gate takes it, it reaches the release, the run is clean', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const r = await run(rel, stagedSite([A, B]), fakeFpl(), { now: FINAL });
  assert.equal(r.code, 0);
  assert.deepEqual(r.summary.captures.map((c) => c.phase), ['pre']);
  assertArchived(rel, [A, B]);
  // A and B, the week-old staged pre capture, plus the three endpoints just taken.
  assert.deepEqual(releaseCaptures(rel, 'pre', 11), ['bootstrap', 'bootstrap', 'event-status', 'fixtures', 'fixtures']);
  const fresh = rel.manifest().entries.find((e) => e.phase === 'pre' && e.endpoint === 'fixtures' && e.file && e.file !== B.file);
  const { meta, body } = decodeRecord(rel.assets.get(fresh.file).buf);
  assert.equal(meta.deadline, iso(GW11));
  assert.deepEqual(body, [{ id: 1, team_h: 1, team_a: 2 }]);
  // The next run has nothing to do: no second final-window capture, no writes.
  const writes = rel.writes().length;
  const again = await run(rel, stagedSite([A, B]), fakeFpl(), { now: iso(GW11 - 0.5 * 3600e3) });
  assert.equal(again.code, 0);
  assert.deepEqual(again.summary.captures, []);
  assert.equal(rel.writes().length, writes);
});

test('R7. two captures due and FPL refuses one: the other is kept and archived, and the run fails (1)', async () => {
  // Before 2026-11-23 the refused live capture threw away the pre capture
  // taken seconds earlier in the same run.
  const rel = fakeRelease({ snaps: [A] });
  const fpl = fakeFpl({ checked: true });
  fpl.faults.push({ when: (p) => p === 'event/10/live/', times: 99, respond: EDGE_403 });
  const r = await run(rel, stagedSite([A]), fpl, { now: FINAL });
  assert.deepEqual(r.summary.captures.map((c) => c.phase).sort(), ['live', 'pre']);
  assert.equal(r.captureErrors.length, 1);
  assert.match(r.captureErrors[0].message, /^live: HTTP 403/);
  assert.equal(r.code, 1);
  assert.deepEqual(releaseCaptures(rel, 'pre', 11), ['bootstrap', 'bootstrap', 'event-status', 'fixtures']);
  assert.deepEqual(releaseCaptures(rel, 'live', 10), []);
  // FPL answers again: the next run takes only the live capture still owed.
  const next = await run(rel, stagedSite([A]), fakeFpl({ checked: true }), { now: iso(GW11 - 0.5 * 3600e3) });
  assert.equal(next.code, 0);
  assert.deepEqual(next.summary.captures.map((c) => c.phase), ['live']);
  assert.deepEqual(releaseCaptures(rel, 'live', 10), ['live']);
  assert.deepEqual(releaseCaptures(rel, 'pre', 11), ['bootstrap', 'bootstrap', 'event-status', 'fixtures']);
});

test('R8. Netlify staging is down and FPL answers: the gate still captures what is due, and the run fails (1) for the copy', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const site = stagedSite([A, B]);
  site.faults.push({ when: (u) => u.includes('?season='), times: 99, respond: () => new Response('', { status: 503 }) });
  const r = await run(rel, site, fakeFpl(), { now: FINAL });
  assert.ok(r.stagedError);
  assert.equal(r.code, 1);
  assert.deepEqual(releaseCaptures(rel, 'pre', 11), ['bootstrap', 'bootstrap', 'event-status', 'fixtures']);
});

test('R9. FPL refuses AND staging is down, unreadable or empty: nothing is written and the run fails (1)', async () => {
  const fpl403 = () => { const f = fakeFpl(); f.faults.push({ when: (p) => p === 'bootstrap-static/', times: 99, respond: EDGE_403 }); return f; };
  // The season list is down: no season, nothing can be copied.
  let rel = fakeRelease({ snaps: [A] });
  let site = stagedSite([A, B]);
  site.faults.push({ when: (u) => u === BASE, times: 99, respond: () => new Response('', { status: 400 }) });
  let r = await run(rel, site, fpl403());
  assert.equal(r.code, 1);
  assert.equal(r.thrown.status, 403);
  assert.deepEqual(rel.writes(), []);
  // The season list answers, the manifest does not.
  rel = fakeRelease({ snaps: [A] });
  site = stagedSite([A, B]);
  site.faults.push({ when: (u) => u.includes('?season='), times: 99, respond: () => new Response('', { status: 400 }) });
  r = await run(rel, site, fpl403());
  assert.equal(r.code, 1);
  assert.match(r.stagedError.message, /staged manifest: HTTP 400/);
  assert.deepEqual(rel.writes(), []);
  // A staged manifest that is not one.
  rel = fakeRelease({ snaps: [A] });
  site = stagedSite([A, B]);
  site.map.set(`${SEASON}/manifest.json`, JSON.stringify({ entries: 'no' }));
  r = await run(rel, site, fpl403());
  assert.equal(r.code, 1);
  assert.match(r.stagedError.message, /malformed/);
  assert.deepEqual(rel.writes(), []);
  // Nothing staged at all: there is no season to copy, so FPL's error stands.
  rel = fakeRelease({ snaps: [A] });
  r = await run(rel, stagedSite(null), fpl403());
  assert.equal(r.code, 1);
  assert.deepEqual(rel.writes(), []);
});

test('R10. a run killed half way through its upload, then a run with FPL refusing: the second finishes the job, nothing lost or doubled', async () => {
  const rel = fakeRelease({ snaps: [A] });
  rel.faults.push({ when: (a) => a[1] === 'upload' && a.join(' ').includes(C.file), times: 1, error: 'the runner was cancelled', effect: 'land', kill: true });
  const first = await run(rel, stagedSite([A, B, C, D]), fakeFpl());
  assert.equal(first.code, 1);
  rel.dead = false;
  const fpl = fakeFpl();
  fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 1, respond: EDGE_403 });
  const second = await run(rel, stagedSite([A, B, C, D]), fpl);
  assert.equal(second.code, 75);
  assertArchived(rel, [A, B, C, D]);
  assert.equal(rel.manifest().entries.length, 4);
});

test('R11. GitHub refusing every upload fails the run (1) even when FPL is down too, and the next run completes it', async () => {
  const rel = fakeRelease({ snaps: [A] });
  rel.faults.push({ when: (a) => a[1] === 'upload', times: 4, error: 'HTTP 503' });
  const fpl = fakeFpl();
  fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 1, respond: EDGE_403 });
  const r = await run(rel, stagedSite([A, B]), fpl);
  assert.equal(r.code, 1);
  assert.match(r.thrown.message, /uploading .* failed after 4 attempts/);
  assert.equal(rel.manifest().entries.length, 1, 'the index was not touched');
  const next = await run(rel, stagedSite([A, B]), fakeFpl());
  assert.equal(next.code, 0);
  assertArchived(rel, [A, B]);
});

test('R12. a capture a person asked for that FPL refuses fails the run (1), after the copy', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const fpl = fakeFpl();
  fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 1, respond: EDGE_403 });
  const r = await run(rel, stagedSite([A, B]), fpl, { phase: 'post' });
  assert.equal(r.code, 1);
  assertArchived(rel, [A, B]);
  // A requested live capture of a finished gameweek, with FPL answering: taken.
  const live = await run(rel, stagedSite([A, B]), fakeFpl(), { phase: 'live', gw: 10 });
  assert.equal(live.code, 0);
  assert.deepEqual(releaseCaptures(rel, 'live', 10), ['live']);
});

test('R13. a bootstrap FPL serves with the wrong shape is not an outage: the copy happens and the run fails (1)', async () => {
  const rel = fakeRelease({ snaps: [A] });
  const fpl = fakeFpl();
  fpl.faults.push({ when: (p) => p === 'bootstrap-static/', times: 1, respond: () => new Response('{"events":[]}', { status: 200 }) });
  const r = await run(rel, stagedSite([A, B]), fpl);
  assert.equal(r.code, 1);
  assertArchived(rel, [A, B]);
});

test('the exit code for each outcome', () => {
  const upstream = Object.assign(new Error('bootstrap: HTTP 403'), { upstream: true, status: 403 });
  const updating = Object.assign(new Error('updating'), { gameUpdating: true });
  const shape = new Error('bootstrap: refused, 19 teams');
  const cases = [
    [{}, 0],
    [{ fplError: upstream }, 75],
    [{ fplError: updating }, 75],
    [{ fplError: shape }, 1],
    [{ phase: 'pre', fplError: upstream }, 1],
    [{ phase: 'pre', fplError: updating }, 75],
    [{ fplError: upstream, stagedError: new Error('x') }, 1],
    [{ captureErrors: [upstream] }, 1],
    [{ captureErrors: [updating] }, 75],
    [{ captureErrors: [updating, upstream] }, 1],
  ];
  for (const [given, code] of cases) assert.equal(exitCodeFor(given), code, JSON.stringify(given));
});

test('the staged season list: the newest season, null when empty, an error when it is not a list of seasons', async () => {
  const answer = (body) => async () => new Response(body, { status: 200 });
  assert.equal(await newestStagedSeason({ base: BASE, fetchImpl: answer('{"seasons":["2027-28","2026-27"]}') }), '2027-28');
  assert.equal(await newestStagedSeason({ base: BASE, fetchImpl: answer('{"seasons":[]}') }), null);
  await assert.rejects(newestStagedSeason({ base: BASE, fetchImpl: answer('{"seasons":["../x"]}') }), /not a season/);
  await assert.rejects(newestStagedSeason({ base: BASE, fetchImpl: answer('{}') }), /malformed/);
  await assert.rejects(newestStagedSeason({ base: BASE, fetchImpl: answer('<html>') }), /not JSON/);
});

test('the script itself: FPL refusing exits 75 with what everything staged copied; FPL and the staged season list both failing exits 1', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const staged = workDir();
  const snaps = [A, B, C];
  writeFileSync(join(staged, 'manifest.json'), JSON.stringify(manifestOf(snaps)));
  for (const s of snaps) writeFileSync(join(staged, s.file), s.gz);
  const script = (env) => {
    const out = workDir();
    const r = spawnSync(process.execPath, [
      '--import', join(here, 'helpers', 'archive-fetch-preload.mjs'),
      join(here, '..', 'scripts', 'archive-snapshot.mjs'), '--staged', 'https://staged.test/export', '--out', out,
    ], { encoding: 'utf8', env: { ...process.env, ARCHIVE_TEST_STAGED_DIR: staged, ...env } });
    return { ...r, out: join(out, SEASON) };
  };
  const ok = script({});
  assert.equal(ok.status, 75, ok.stderr);
  assert.match(ok.stderr, /::warning::FPL's bootstrap could not be read: bootstrap: HTTP 403 \(x-served-by: cache-test, body: ""\)/);
  for (const s of snaps) assert.ok(readFileSync(join(ok.out, s.file)).equals(s.gz), `${s.file} copied byte for byte`);
  assert.deepEqual(JSON.parse(readFileSync(join(ok.out, 'manifest.json'), 'utf8')).entries.map(entryKey), snaps.map((s) => entryKey(s.entry)));
  const down = script({ ARCHIVE_TEST_SEASONS_STATUS: '400' });
  assert.equal(down.status, 1, down.stderr);
  assert.match(down.stderr, /bootstrap: HTTP 403/);
  assert.match(down.stderr, /staged seasons: HTTP 400/);
});
