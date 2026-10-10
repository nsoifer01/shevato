// The FPL deadline archive's Netlify side: the hourly capture into the
// `fpl-archive` staging store, and the read-only export the GitHub workflow
// syncs to the release from. Hermetic: an in-memory store with Netlify Blobs'
// conditional writes, and a fake FPL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

import { stageCaptures, manifestKey, fileKey, validFile } from '../lib/fpl-archive-stage.mjs';
import { handleExport } from '../fpl-archive-export.mjs';
import { config } from '../fpl-archive-capture.mjs';

function memoryStore() {
  const map = new Map();
  let etagN = 0;
  const etags = new Map();
  const put = (key, value, opts = {}) => {
    if (opts.onlyIfNew && map.has(key)) return { modified: false };
    if (opts.onlyIfMatch && etags.get(key) !== opts.onlyIfMatch) return { modified: false };
    map.set(key, value);
    etags.set(key, `e${++etagN}`);
    return { modified: true, etag: etags.get(key) };
  };
  return {
    map,
    async set(key, value, opts) { return put(key, Buffer.from(value), opts); },
    async setJSON(key, value, opts) { return put(key, JSON.stringify(value), opts); },
    async get(key, { type } = {}) {
      if (!map.has(key)) return null;
      const v = map.get(key);
      if (type === 'json') return JSON.parse(String(v));
      if (type === 'arrayBuffer') { const b = Buffer.from(v); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      return v;
    },
    async getWithMetadata(key, { type } = {}) {
      if (!map.has(key)) return null;
      return { data: await this.get(key, { type }), etag: etags.get(key), metadata: {} };
    },
    async list({ prefix = '', directories = false } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix));
      if (!directories) return { blobs: keys.map((key) => ({ key })), directories: [] };
      const dirs = new Set();
      const blobs = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const i = rest.indexOf('/');
        if (i >= 0) dirs.add(prefix + rest.slice(0, i + 1)); else blobs.push({ key: k });
      }
      return { blobs, directories: [...dirs] };
    },
  };
}

const DEADLINE = Date.parse('2026-10-17T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// A fake FPL: bootstrap with GW7 next (deadline above) and GW6 finished and
// checked; `version` changes the bootstrap bytes, fixtures never change.
function fpl({ version = 1, gw6Checked = true } = {}) {
  const bootstrap = {
    elements: [{ id: 1, team: 1, element_type: 3, now_cost: 50 + version, total_points: 0 }],
    teams: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })),
    events: [
      { id: 1, deadline_time: '2026-08-21T17:30:00Z', finished: true, data_checked: true },
      { id: 6, deadline_time: '2026-10-10T10:00:00Z', finished: true, data_checked: gw6Checked },
      { id: 7, deadline_time: iso(DEADLINE), finished: false, data_checked: false },
    ],
  };
  const bodies = {
    'bootstrap-static/': bootstrap,
    'fixtures/': [{ id: 1, team_h: 1, team_a: 2 }],
    'event-status/': { status: [], leagues: 'Updated' },
    'event/6/live/': { elements: [{ id: 1, stats: { total_points: 2 } }] },
  };
  const calls = [];
  const fetchImpl = async (url) => {
    const path = url.replace('https://fantasy.premierleague.com/api/', '');
    calls.push(path);
    if (!(path in bodies)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(bodies[path]), { status: 200, headers: { date: new Date().toUTCString() } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const at = (ms) => () => iso(ms);

test('inside the final two hours the first run stages a pre capture and the live stats of the checked gameweek', async () => {
  const store = memoryStore();
  const r = await stageCaptures({ store, fetchImpl: fpl(), now: at(DEADLINE - 90 * 60e3) });
  assert.equal(r.season, '2026-27');
  assert.deepEqual(r.captures.map((c) => c.phase).sort(), ['live', 'pre']);
  const manifest = JSON.parse(store.map.get(manifestKey('2026-27')));
  assert.equal(manifest.entries.length, 4, 'bootstrap, fixtures, event-status, live');
  for (const file of r.written) {
    assert.ok(store.map.has(fileKey('2026-27', file)));
    const rec = JSON.parse(gunzipSync(store.map.get(fileKey('2026-27', file))).toString('utf8'));
    assert.equal(rec.season, '2026-27');
  }
});

test('the next run in the same window has nothing to do, and asks FPL for the bootstrap only', async () => {
  const store = memoryStore();
  await stageCaptures({ store, fetchImpl: fpl(), now: at(DEADLINE - 90 * 60e3) });
  const f = fpl();
  const r = await stageCaptures({ store, fetchImpl: f, now: at(DEADLINE - 30 * 60e3) });
  assert.deepEqual(r.captures, []);
  assert.deepEqual(f.calls, ['bootstrap-static/']);
});

test('after the deadline a post capture is staged, and unchanged payloads are pointers, not copies', async () => {
  const store = memoryStore();
  await stageCaptures({ store, fetchImpl: fpl(), now: at(DEADLINE - 90 * 60e3) });
  const before = store.map.size;
  const r = await stageCaptures({ store, fetchImpl: fpl({ version: 2 }), now: at(DEADLINE + 30 * 60e3) });
  assert.deepEqual(r.captures.map((c) => c.phase), ['post']);
  assert.deepEqual(r.written.length, 1, 'only the changed bootstrap is stored');
  assert.equal(store.map.size, before + 1);
  const manifest = JSON.parse(store.map.get(manifestKey('2026-27')));
  const post = manifest.entries.filter((e) => e.phase === 'post');
  assert.equal(post.length, 3);
  assert.deepEqual(post.filter((e) => e.sameAs).map((e) => e.endpoint).sort(), ['event-status', 'fixtures']);
});

test('a staged snapshot is never overwritten, and a manifest that moved underneath a run is not clobbered', async () => {
  const store = memoryStore();
  await stageCaptures({ store, fetchImpl: fpl(), now: at(DEADLINE - 90 * 60e3) });
  const manifest = JSON.parse(store.map.get(manifestKey('2026-27')));
  // Another run writes the manifest between this run's read and write.
  const racing = memoryStore();
  for (const [k, v] of store.map) racing.map.set(k, v);
  const origSetJSON = racing.setJSON.bind(racing);
  racing.setJSON = async (key, value, opts) => {
    if (key === manifestKey('2026-27')) await origSetJSON(key, { ...manifest, entries: [...manifest.entries] }, {});
    return origSetJSON(key, value, opts);
  };
  await assert.rejects(
    stageCaptures({ store: racing, fetchImpl: fpl({ version: 3 }), now: at(DEADLINE + 30 * 60e3) }),
    /changed underneath this run/,
  );
  // And a file key that already exists refuses the write.
  const clash = memoryStore();
  const r = await stageCaptures({ store: clash, fetchImpl: fpl(), now: at(DEADLINE - 90 * 60e3) });
  clash.map.delete(manifestKey('2026-27'));
  await assert.rejects(
    stageCaptures({ store: clash, fetchImpl: fpl(), now: at(DEADLINE - 90 * 60e3) }),
    /already exists/,
  );
  assert.ok(r.written.length > 0);
});

test('the export serves seasons, the manifest and snapshots, and nothing else', async () => {
  const store = memoryStore();
  const r = await stageCaptures({ store, fetchImpl: fpl(), now: at(DEADLINE - 90 * 60e3) });
  const req = (qs, method = 'GET') => new Request(`https://shevato.com/.netlify/functions/fpl-archive-export${qs}`, { method });

  assert.deepEqual(await (await handleExport(req(''), store)).json(), { seasons: ['2026-27'] });
  const m = await handleExport(req('?season=2026-27'), store);
  assert.equal(m.status, 200);
  assert.equal((await m.json()).entries.length, 4);

  const file = r.written[0];
  const f = await handleExport(req(`?season=2026-27&file=${file}`), store);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'application/gzip');
  assert.ok(Buffer.from(await f.arrayBuffer()).equals(store.map.get(fileKey('2026-27', file))));

  assert.equal((await handleExport(req('?season=2026-27&file=manifest.json'), store)).status, 400);
  assert.equal((await handleExport(req('?season=2026-27&file=../x'), store)).status, 400);
  assert.equal((await handleExport(req('?season=../../x'), store)).status, 400);
  assert.equal((await handleExport(req('?season=2025-26'), store)).status, 404);
  assert.equal((await handleExport(req('?season=2026-27&file=pre-gw07-20261017T080000Z-bootstrap.json.gz'), store)).status, 404);
  assert.equal((await handleExport(req('', 'POST'), store)).status, 405);
  assert.equal(validFile('pre-gw07-20261017T080000Z-bootstrap.json.gz'), true);
});

test('the capture runs hourly on Netlify\'s scheduler', () => {
  assert.equal(config.schedule, '7 * * * *');
});
