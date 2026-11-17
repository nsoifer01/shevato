import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  captureForRoster, captureRun, handleSnapshots, sanitizeRoster, captureTargetFor, dailyFileUrl,
  uidFromIdToken, FIREBASE_WEB_API_KEY, TOKEN_LOOKUP_URL, PROFILE_URL, RUN_INTERVAL_MS,
  rosterKey, snapKey, SNAPSHOT_STORE,
} from '../lib/maptap-snapshots.mjs';
import { config as captureConfig } from '../maptap-snapshot-capture.mjs';
import stats from '../../../apps/maptap-rivals/js/stats.js';

// In-memory stand-in for the Blobs surface the snapshot code uses.
function memStore() {
  const map = new Map();
  return {
    map,
    writes: 0,
    async get(key) { return map.has(key) ? JSON.parse(map.get(key)) : null; },
    async setJSON(key, value, cond = {}) {
      this.writes += 1;
      if (cond.onlyIfNew && map.has(key)) return { modified: false };
      map.set(key, JSON.stringify(value));
      return { modified: true };
    },
    async list({ prefix = '' } = {}) { return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(key) { map.delete(key); },
  };
}

const PARIS = { lat: 48.8566, lng: 2.3522 };
const CITIES = [[48.8566, 2.3522], [52.52, 13.405], [35.6762, 139.6503], [40.7128, -74.006], [-33.9249, 18.4241]];
const fileFor = (iso, dated = true) => 'const cities = [' + CITIES.map(([lat, lng], i) =>
  `{ ${dated ? `id: "${iso}-c${i}", ` : ''}name: "C${i}", lat: ${lat}, lng: ${lng} }`).join(',') + '];';
// A MapTap gameHistory: `days` days before `before`, every round at Paris scoring `score`.
function history(before, days, score, { at = PARIS } = {}) {
  const out = {};
  for (let i = 1; i <= days; i++) {
    const d = new Date(Date.parse(before + 'T00:00:00Z') - i * 86400000).toISOString().slice(0, 10);
    out[d] = { finalScore: 0, roundData: [1, 2, 3, 4, 5].map((round) => ({ round, score, cityLat: at.lat, cityLng: at.lng, cityName: 'Paris' })) };
  }
  return out;
}

// One fetch stub for the three upstreams: the daily file, MapTap profiles,
// Google's token lookup. `profiles` maps nickname -> gameHistory (or an Error).
function upstream({ file, profiles = {}, tokens = {} }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    const ok = (body, status = 200) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
    if (url.startsWith('https://maptap.gg/')) return file == null ? ok('', 404) : ok(file);
    if (url === PROFILE_URL) {
      const nick = JSON.parse(init.body).data.nickname;
      const h = profiles[nick];
      if (h instanceof Error) throw h;
      return h ? ok({ result: { success: true, user: { gameHistory: h } } }) : ok({ result: { success: false } });
    }
    if (url === TOKEN_LOOKUP_URL) {
      const uid = tokens[JSON.parse(init.body).idToken];
      return uid ? ok({ users: [{ localId: uid }] }) : ok({ error: { message: 'INVALID_ID_TOKEN' } }, 400);
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { fetchImpl, calls };
}

const T = (iso, hh, mm = 0) => Date.parse(`${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
const ROSTER = { me: 'me_user', rivals: [{ id: 'r1', username: 'rival_one' }] };

test('schedule: every run is before 10:00 UTC, three hours apart, so the last one is the 09:17', () => {
  const [min, hours] = captureConfig.schedule.split(' ');
  assert.equal(min, '17');
  const hs = hours.split(',').map(Number);
  assert.ok(hs.every((h) => h < 10));
  for (let i = 1; i < hs.length; i++) assert.equal((hs[i] - hs[i - 1]) * 3600000, RUN_INTERVAL_MS);
});

test('captureTargetFor: tomorrow in UTC, the day whose cutoff is 10:00 UTC today', () => {
  assert.equal(captureTargetFor(T('2026-11-17', 3, 17)), '2026-11-18');
  assert.equal(captureTargetFor(T('2026-12-31', 9, 17)), '2027-01-01');
  assert.equal(captureTargetFor(T('2028-02-28', 6, 17)), '2028-02-29');
  assert.equal(dailyFileUrl('2026-11-18'), 'https://maptap.gg/data/this_day_in_history/November18.js');
});

test('the token lookup uses the same public web API key the site ships', () => {
  const cfg = readFileSync(new URL('../../../firebase-config.js', import.meta.url), 'utf8');
  assert.match(cfg, new RegExp(`apiKey:\\s*"${FIREBASE_WEB_API_KEY}"`));
  assert.ok(TOKEN_LOOKUP_URL.endsWith(`key=${FIREBASE_WEB_API_KEY}`));
});

test('captureForRoster: stores one pre-game snapshot from the predictor; a constant history predicts that constant', async () => {
  const store = memStore();
  const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: history('2026-11-18', 10, 80), rival_one: history('2026-11-18', 10, 60) } });
  const r = await captureForRoster({ store, uid: 'u1', roster: ROSTER, nowMs: T('2026-11-17', 6, 17), fetchImpl });
  assert.equal(r.status, 'captured');
  const [key] = [...store.map.keys()];
  const snap = JSON.parse(store.map.get(key));
  assert.equal(key, snapKey('u1', '2026-11-18', snap.puzzle));
  assert.deepEqual([snap.date, snap.source, snap.puzzleDated, snap.through, snap.takenAt], ['2026-11-18', 'scheduled', true, '2026-11-17', '2026-11-17T06:17:00.000Z']);
  // Hand oracle: every round of the history scored 80 (60), so every round predicts 80 (60).
  assert.deepEqual(snap.players['@me'], { r: [80, 80, 80, 80, 80], t: 800, p: 1 });
  assert.deepEqual(snap.players.r1, { r: [60, 60, 60, 60, 60], t: 600, p: 2 });
  assert.ok(!JSON.stringify(snap).includes('me_user') && !JSON.stringify(snap).includes('rival_one'), 'no usernames in a snapshot');
  assert.deepEqual(stats.sanitizeSnapshots({ [stats.snapshotId(snap)]: snap }), { [stats.snapshotId(snap)]: snap }, 'the app accepts it as is');
});

test('captureForRoster: never reads the target day or later, even if a history somehow had it', async () => {
  const store = memStore();
  const h = history('2026-11-18', 10, 80);
  h['2026-11-18'] = { roundData: [1, 2, 3, 4, 5].map((round) => ({ round, score: 0, cityLat: PARIS.lat, cityLng: PARIS.lng })) };
  const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: h } });
  await captureForRoster({ store, uid: 'u1', roster: { me: 'me_user', rivals: [] }, nowMs: T('2026-11-17', 3, 17), fetchImpl });
  const snap = JSON.parse([...store.map.values()][0]);
  assert.equal(snap.players['@me'].t, 800);
  assert.equal(snap.through, '2026-11-17');
});

test('captureForRoster: at or after 10:00 UTC the next day is no longer pre-game and nothing is fetched', async () => {
  const store = memStore();
  const { fetchImpl, calls } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: history('2026-11-18', 10, 80) } });
  for (const now of [T('2026-11-17', 10, 0), T('2026-11-17', 23, 59)]) {
    const r = await captureForRoster({ store, uid: 'u1', roster: ROSTER, nowMs: now, fetchImpl });
    assert.deepEqual([r.target, r.status], ['2026-11-18', 'past-cutoff']);
  }
  assert.equal(calls.length, 0);
  assert.equal(store.map.size, 0);
});

test('captureForRoster: idempotent per puzzle; a rewritten file before the cutoff gets its own snapshot', async () => {
  const store = memStore();
  const profiles = { me_user: history('2026-11-18', 10, 80), rival_one: history('2026-11-18', 10, 60) };
  let { fetchImpl } = upstream({ file: fileFor('2026-11-18', false), profiles });
  assert.equal((await captureForRoster({ store, uid: 'u1', roster: ROSTER, nowMs: T('2026-11-17', 3, 17), fetchImpl })).puzzleDated, false);
  assert.equal((await captureForRoster({ store, uid: 'u1', roster: ROSTER, nowMs: T('2026-11-17', 6, 17), fetchImpl })).status, 'exists');
  assert.equal(store.map.size, 1);
  // Same coordinates, now dated: same puzzle, still one snapshot.
  ({ fetchImpl } = upstream({ file: fileFor('2026-11-18', true), profiles }));
  assert.equal((await captureForRoster({ store, uid: 'u1', roster: ROSTER, nowMs: T('2026-11-17', 9, 17), fetchImpl })).status, 'exists');
  // A different puzzle served before the cutoff is a different forecast.
  const moved = fileFor('2026-11-18', true).replace('-33.9249', '-34.5');
  ({ fetchImpl } = upstream({ file: moved, profiles }));
  assert.equal((await captureForRoster({ store, uid: 'u1', roster: ROSTER, nowMs: T('2026-11-17', 9, 17), fetchImpl })).status, 'captured');
  assert.equal(store.map.size, 2);
});

test('captureForRoster: a missing profile waits for the next run, and the last run captures who it has', async () => {
  const store = memStore();
  const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: history('2026-11-18', 10, 80), rival_one: new Error('timeout') } });
  const early = await captureForRoster({ store, uid: 'u1', roster: ROSTER, nowMs: T('2026-11-17', 6, 17), fetchImpl });
  assert.deepEqual([early.status, early.missing, store.map.size], ['retry', 1, 0]);
  const last = await captureForRoster({ store, uid: 'u1', roster: ROSTER, nowMs: T('2026-11-17', 9, 17), fetchImpl });
  assert.deepEqual([last.status, last.missing, last.players], ['captured', 1, 1]);
});

test('captureForRoster: no puzzle, an unreadable one or no predictable player stores nothing', async () => {
  for (const [file, profiles, status] of [
    [null, { me_user: history('2026-11-18', 10, 80) }, 'puzzle-unavailable'],
    ['const cities = [{ lat: 1, lng: 2 }];', { me_user: history('2026-11-18', 10, 80) }, 'puzzle-unreadable'],
    [fileFor('2026-11-18'), { me_user: history('2026-11-18', 0, 80) }, 'no-prediction'],
  ]) {
    const store = memStore();
    const { fetchImpl } = upstream({ file, profiles });
    const r = await captureForRoster({ store, uid: 'u1', roster: { me: 'me_user', rivals: [] }, nowMs: T('2026-11-17', 9, 17), fetchImpl });
    assert.equal(r.status, status);
    assert.equal(store.map.size, 0);
  }
});

test('captureRun: only allowlisted accounts are captured, and an unset allowlist turns it off', async () => {
  const store = memStore();
  await store.setJSON(rosterKey('owner'), { me: 'me_user', rivals: [] });
  await store.setJSON(rosterKey('stranger'), { me: 'me_user', rivals: [] });
  const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: history('2026-11-18', 10, 80) } });
  assert.deepEqual(await captureRun({ store, nowMs: T('2026-11-17', 6, 17), fetchImpl, allowlist: '' }), { results: [], disabled: true });
  const run = await captureRun({ store, nowMs: T('2026-11-17', 6, 17), fetchImpl, allowlist: ' owner ,' });
  assert.deepEqual(run.results.map((r) => [r.uid, r.status]), [['owner', 'captured']]);
  assert.equal([...store.map.keys()].filter((k) => k.startsWith('snap/stranger/')).length, 0);
});

test('sanitizeRoster: keeps usable ids and usernames, bounded', () => {
  assert.equal(sanitizeRoster(null), null);
  assert.equal(sanitizeRoster({ me: 'a' }), null);
  assert.equal(sanitizeRoster({ me: 'bad name', rivals: [] }), null);
  assert.deepEqual(sanitizeRoster({ me: 'me', rivals: [{ id: 'r1', username: 'u1' }, { id: 'r1', username: 'dup' }, { id: 'bad id', username: 'x' },
    { id: 'r2', username: 'has space' }, { id: 'r3', username: 'ok_3' }, 'junk'] }), { me: 'me', rivals: [{ id: 'r1', username: 'u1' }, { id: 'r3', username: 'ok_3' }] });
  const many = { me: null, rivals: Array.from({ length: 80 }, (_, i) => ({ id: 'r' + i, username: 'u' + i })) };
  assert.equal(sanitizeRoster(many).rivals.length, 60);
});

function req(method, { origin = 'https://shevato.com', token, body } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request('https://shevato.com/.netlify/functions/maptap-snapshots', { method, headers, body });
}
const GOOD = 'good-token-for-owner-0123456789';
const OTHER = 'good-token-for-other-0123456789';

test('handleSnapshots: refuses other origins, missing or invalid tokens, and accounts not enabled', async () => {
  const store = memStore();
  const { fetchImpl } = upstream({ tokens: { [GOOD]: 'owner', [OTHER]: 'someone' } });
  const opts = { store, allowlist: 'owner', fetchImpl };
  assert.equal((await handleSnapshots(req('GET', { origin: 'https://evil.example', token: GOOD }), opts)).status, 403);
  assert.equal((await handleSnapshots(req('GET', {}), opts)).status, 401);
  assert.equal((await handleSnapshots(req('GET', { token: 'not-a-valid-token-at-all-xx' }), opts)).status, 401);
  assert.equal((await handleSnapshots(req('GET', { token: OTHER }), opts)).status, 403);
  assert.equal((await handleSnapshots(req('GET', { token: GOOD }), { ...opts, allowlist: '' })).status, 403);
  assert.equal((await handleSnapshots(req('PUT', { token: OTHER, body: JSON.stringify(ROSTER) }), opts)).status, 403);
  assert.equal(store.map.size, 0);
});

test('handleSnapshots: the enabled account registers a roster, reads only its own valid snapshots, and can delete everything', async () => {
  const store = memStore();
  const { fetchImpl } = upstream({ tokens: { [GOOD]: 'owner' }, file: fileFor('2026-11-18'), profiles: { me_user: history('2026-11-18', 10, 80), rival_one: history('2026-11-18', 10, 60) } });
  const opts = { store, allowlist: 'owner', fetchImpl };
  assert.equal((await handleSnapshots(req('PUT', { token: GOOD, body: '{' }), opts)).status, 400);
  assert.equal((await handleSnapshots(req('PUT', { token: GOOD, body: JSON.stringify({ rivals: 'x' }) }), opts)).status, 400);
  const put = await handleSnapshots(req('PUT', { token: GOOD, body: JSON.stringify({ ...ROSTER, extra: 'ignored' }) }), opts);
  assert.equal(put.status, 200);
  const stored = await store.get(rosterKey('owner'));
  assert.deepEqual({ me: stored.me, rivals: stored.rivals }, ROSTER);
  await captureRun({ store, nowMs: T('2026-11-17', 6, 17), fetchImpl, allowlist: 'owner' });
  await store.setJSON('snap/owner/2026-11-19/junk', { not: 'a snapshot' });
  await store.setJSON('snap/someone/2026-11-18/abc', { not: 'theirs' });
  const got = await (await handleSnapshots(req('GET', { token: GOOD }), opts)).json();
  const ids = Object.keys(got.snapshots);
  assert.equal(ids.length, 1);
  assert.match(ids[0], /^2026-11-18@2026-11-17T06:17:00\.000Z$/);
  assert.equal((await handleSnapshots(req('POST', { token: GOOD }), opts)).status, 405);
  const del = await (await handleSnapshots(req('DELETE', { token: GOOD }), opts)).json();
  assert.equal(del.removed, 2);
  assert.deepEqual([...store.map.keys()], ['snap/someone/2026-11-18/abc']);
});

test('uidFromIdToken: a failing or odd lookup is never a user', async () => {
  const bad = [async () => { throw new Error('down'); }, async () => ({ ok: true, json: async () => ({ users: [{ localId: 'x', disabled: true }] }) }),
    async () => ({ ok: true, json: async () => ({}) }), async () => ({ ok: false, json: async () => ({}) })];
  for (const f of bad) assert.equal(await uidFromIdToken('a-long-enough-token-value', f), null);
  assert.equal(await uidFromIdToken('short', async () => { throw new Error('must not be called'); }), null);
  assert.equal(SNAPSHOT_STORE, 'maptap-snapshots');
});
