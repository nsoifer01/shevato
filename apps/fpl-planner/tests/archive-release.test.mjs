// The deadline archive's GitHub side (scripts/lib/archive-release.mjs) and the
// retrying fetch under it (scripts/lib/archive.mjs fetchWithRetry), hermetic.
//
// WHY THESE TESTS (2026-11-13, after run 43330644438 failed on one dropped
// connection). The release is the season's permanent record, so the properties
// that matter are about what happens when things go wrong half way: nothing
// archived is ever replaced or forgotten, a run that died is finished by the
// next one, a transient failure is retried and a permanent one is loud, and a
// healthy run moves no bytes it does not have to. Each round below is the
// production sequence archive-snapshot.mjs runs (readRelease, pullStaged,
// loadManifest, syncRelease) against a fake `gh` release that keeps real bytes
// and the REAL staged export handler (netlify/functions/fpl-archive-export.mjs)
// behind a fetch that can fail on cue. The expected states come from the
// scenario itself (which snapshots exist where), never from re-running the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildRecord, encodeRecord, snapshotFileName, emptyManifest, addToManifest, fetchWithRetry, retryAfterMs, fetchEndpoint,
} from '../scripts/lib/archive.mjs';
import {
  readRelease, pullStaged, loadManifest, syncRelease, planStagedPull, entryKey,
} from '../scripts/lib/archive-release.mjs';
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
 * A GitHub release behind a `gh` with the CLI's real semantics: no-clobber
 * uploads refuse an existing name, --clobber deletes before it uploads, a
 * missing release is "release not found". `faults` fail calls on cue:
 * { when(args) -> bool, times, error, effect: 'none' | 'land' | 'delete' }.
 */
function fakeRelease({ exists = true, snaps = [], manifest = undefined, extra = {} } = {}) {
  const assets = new Map();
  for (const s of snaps) assets.set(s.file, { buf: s.gz, state: 'uploaded' });
  for (const [name, a] of Object.entries(extra)) assets.set(name, { state: 'uploaded', ...a });
  const m = manifest === undefined ? (snaps.length ? manifestOf(snaps) : null) : manifest;
  if (m) assets.set('manifest.json', { buf: bytesOf(m), state: 'uploaded' });
  const rel = { exists, assets, calls: [], faults: [] };
  const fault = (args, run) => {
    const f = rel.faults.find((x) => x.times > 0 && x.when(args));
    if (!f) return run();
    f.times--;
    if (f.effect === 'land' || f.effect === 'delete') run(f.effect);
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
  rel.manifest = () => (assets.has('manifest.json') ? JSON.parse(assets.get('manifest.json').buf.toString('utf8')) : null);
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
    async list() { return { blobs: [], directories: [`${SEASON}/`] }; },
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
  assert.deepEqual(uploads, [[C.file], ['manifest.json', '--clobber']]);
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
    await assert.rejects(fetchWithRetry('https://x.test/', { label: 'thing', fetchImpl, ...noSleep }), new RegExp(`^Error: thing: HTTP ${status}$`));
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
    ['no index', (rel) => rel.assets.delete('manifest.json'), /no manifest\.json, so its index was lost/],
    ['unreadable index', (rel) => { rel.assets.get('manifest.json').buf = Buffer.from('{"entr'); }, /manifest\.json that is not JSON/],
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

test('11. snapshots an interrupted run uploaded before it died are adopted when identical, then indexed', async () => {
  // The previous run uploaded B and C and died before the manifest.
  const rel = fakeRelease({ snaps: [A], extra: { [B.file]: { buf: B.gz }, [C.file]: { buf: C.gz } } });
  const site = stagedSite([A, B, C, D]);
  const r = await round(rel, site);
  assert.deepEqual(r.release.orphans.sort(), [B.file, C.file].sort());
  assert.deepEqual(r.synced.uploaded, [D.file]);
  assert.deepEqual(r.synced.alreadyThere.sort(), [B.file, C.file].sort());
  assertArchived(rel, [A, B, C, D]);
  assert.deepEqual((await readRelease({ tag: TAG, gh: rel.gh })).orphans, []);
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

test('14. a manifest upload that never succeeds is loud; if it left no index, the next run refuses rather than rebuild one', async () => {
  const rel = fakeRelease({ snaps: [A] });
  rel.faults.push({ when: (a) => a.includes('--clobber'), times: 99, error: 'HTTP 500', effect: 'delete' });
  await assert.rejects(round(rel, stagedSite([A, B])), /manifest\.json did not reach release .* after 4 attempts/);
  assert.equal(rel.manifest(), null);
  rel.faults.length = 0;
  await assert.rejects(round(rel, stagedSite([A, B])), /no manifest\.json, so its index was lost/);
  assert.ok(rel.assets.get(A.file).buf.equals(A.gz), 'A is still there');
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
  assert.equal(printed.length, 2);
  assert.deepEqual(rel.writes(), []);
  assert.ok(!rel.assets.has(B.file));
  assert.ok(existsSync(join(dir, B.file)) && readdirSync(dir).includes('manifest.json'));
});
