import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  captureForRoster, captureRun, handleSnapshots, sanitizeRoster, captureTargetFor, dailyFileUrl,
  uidFromIdToken, FIREBASE_WEB_API_KEY, TOKEN_LOOKUP_URL, PROFILE_URL, RUN_INTERVAL_MS, GONE_TTL_MS,
  rosterKey, historyKey, statusKey, optoutKey, goneKey, snapKey, SNAPSHOT_STORE,
} from '../lib/maptap-snapshots.mjs';
import { config as captureConfig } from '../maptap-snapshot-capture.mjs';
import stats from '../../../apps/maptap-rivals/js/stats.js';

// In-memory stand-in for the Blobs surface the snapshot code uses. `onSet`
// lets a test act at the moment a write lands (a racing delete).
function memStore() {
  const map = new Map();
  return {
    map,
    onSet: null,
    async get(key) { return map.has(key) ? JSON.parse(map.get(key)) : null; },
    async setJSON(key, value, cond = {}) {
      if (cond.onlyIfNew && map.has(key)) return { modified: false };
      map.set(key, JSON.stringify(value));
      if (this.onSet) await this.onSet(key);
      return { modified: true };
    },
    async list({ prefix = '' } = {}) { return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(key) { map.delete(key); },
    keys(prefix = '') { return [...map.keys()].filter((k) => k.startsWith(prefix)).sort(); },
  };
}

const PARIS = { lat: 48.8566, lng: 2.3522 };
const CITIES = [[48.8566, 2.3522], [52.52, 13.405], [35.6762, 139.6503], [40.7128, -74.006], [-33.9249, 18.4241]];
const fileFor = (iso, dated = true) => 'const cities = [' + CITIES.map(([lat, lng], i) =>
  `{ ${dated ? `id: "${iso}-c${i}", ` : ''}name: "C${i}", lat: ${lat}, lng: ${lng} }`).join(',') + '];';
const isoMinus = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
// A MapTap gameHistory: the `days` days before `before`, every round at Paris scoring `score`.
function profile(before, days, score) {
  const out = {};
  for (let i = 1; i <= days; i++) {
    out[isoMinus(before, i)] = { roundData: [1, 2, 3, 4, 5].map((round) => ({ round, score, cityLat: PARIS.lat, cityLng: PARIS.lng })) };
  }
  return out;
}
// The app's upload: per player, `days` logged days ending `end` days before `before`, all scoring `score`.
function logged(before, spec) {
  const rounds = {};
  for (const [key, { days, score, end = 1 }] of Object.entries(spec)) {
    rounds[key] = Array.from({ length: days }, (_, i) => ({ date: isoMinus(before, end + days - 1 - i), cities: [PARIS, PARIS, PARIS, PARIS, PARIS], scores: [score, score, score, score, score] }));
  }
  const history = stats.encodeRoundsHistory(rounds);
  return { rounds: stats.decodeRoundsHistory(history), days: history.days, at: '2026-11-10T12:00:00.000Z', history };
}

function upstream({ file, profiles = {}, tokens = {} }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    const ok = (body, status = 200) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
    if (url.startsWith('https://maptap.gg/')) return file == null ? ok('', 404) : ok(file);
    if (url === PROFILE_URL) {
      const h = profiles[JSON.parse(init.body).data.nickname];
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
const ROSTER = { me: 'me_user', rivals: [{ id: 'r1', username: 'rival_one' }, { id: 'r2', username: null }] };
// A store holding an active roster for u1, as a registered account has.
async function enrolled() { const store = memStore(); await store.setJSON(rosterKey('u1'), { me: null, rivals: [] }); return store; }
const snapOf = (store) => store.keys('snap/').map((k) => JSON.parse(store.map.get(k)));

test('schedule: every run is before 10:00 UTC, three hours apart, so the last one is the 09:17', () => {
  const [min, hours] = captureConfig.schedule.split(' ');
  assert.equal(min, '17');
  const hs = hours.split(',').map(Number);
  assert.ok(hs.every((h) => h < 10));
  for (let i = 1; i < hs.length; i++) assert.equal((hs[i] - hs[i - 1]) * 3600000, RUN_INTERVAL_MS);
});

test('captureTargetFor: tomorrow in UTC, across month, year and leap-day boundaries', () => {
  assert.equal(captureTargetFor(T('2026-11-17', 3, 17)), '2026-11-18');
  assert.equal(captureTargetFor(T('2026-11-30', 9, 17)), '2026-12-01');
  assert.equal(captureTargetFor(T('2026-12-31', 9, 17)), '2027-01-01');
  assert.equal(captureTargetFor(T('2028-02-28', 6, 17)), '2028-02-29');
  assert.equal(dailyFileUrl('2026-11-18'), 'https://maptap.gg/data/this_day_in_history/November18.js');
  assert.equal(dailyFileUrl('2027-01-01'), 'https://maptap.gg/data/this_day_in_history/January1.js');
});

test('the token lookup uses the same public web API key the site ships', () => {
  const cfg = readFileSync(new URL('../../../firebase-config.js', import.meta.url), 'utf8');
  assert.match(cfg, new RegExp(`apiKey:\\s*"${FIREBASE_WEB_API_KEY}"`));
  assert.ok(TOKEN_LOOKUP_URL.endsWith(`key=${FIREBASE_WEB_API_KEY}`));
});

test('captureForRoster: predicts every rostered player from the app\'s log plus newer profile days (hand oracle)', async () => {
  const store = await enrolled();
  // Me: logged 10 days at 80, profile has 3 newer days at 80 too.
  // r1: logged 125 days at 60 ending 5 days back; its profile only returns 3 recent days at 60.
  // r2: no username, logged 20 days at 40.
  const history = logged('2026-11-18', { '@me': { days: 10, score: 80, end: 4 }, r1: { days: 125, score: 60, end: 5 }, r2: { days: 20, score: 40 } });
  const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: profile('2026-11-18', 3, 80), rival_one: profile('2026-11-18', 3, 60) } });
  const r = await captureForRoster({ store, uid: 'u1', roster: ROSTER, history, nowMs: T('2026-11-17', 6, 17), fetchImpl });
  assert.deepEqual([r.status, r.complete, r.players, r.roster, r.unread], ['captured', true, 3, 3, 0]);
  const [snap] = snapOf(store);
  assert.deepEqual([snap.date, snap.source, snap.puzzleDated, snap.through, snap.roster, snap.unread, snap.historyAt],
    ['2026-11-18', 'scheduled', true, '2026-11-17', 3, [], '2026-11-10T12:00:00.000Z']);
  // Constant histories predict their constant: 80, 60, 40, competition-ranked.
  assert.deepEqual(snap.players['@me'], { r: [80, 80, 80, 80, 80], t: 800, p: 1 });
  assert.deepEqual(snap.players.r1, { r: [60, 60, 60, 60, 60], t: 600, p: 2 });
  assert.deepEqual(snap.players.r2, { r: [40, 40, 40, 40, 40], t: 400, p: 3 });
  assert.ok(!/me_user|rival_one/.test(JSON.stringify(snap)), 'no usernames in a snapshot');
  assert.deepEqual(stats.sanitizeSnapshots({ [stats.snapshotId(snap)]: snap }), { [stats.snapshotId(snap)]: snap });
});

test('captureForRoster: a profile with fewer days than the log does not change the forecast', async () => {
  const history = logged('2026-11-18', { r1: { days: 125, score: 60 } });
  const roster = { me: null, rivals: [{ id: 'r1', username: 'rival_one' }] };
  const preds = [];
  for (const h of [profile('2026-11-18', 125, 60), profile('2026-11-18', 2, 60), {}]) {
    const store = await enrolled();
    const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { rival_one: h } });
    await captureForRoster({ store, uid: 'u1', roster, history, nowMs: T('2026-11-17', 6, 17), fetchImpl });
    preds.push(snapOf(store)[0].players.r1);
  }
  assert.deepEqual(preds[1], preds[0]);
  assert.deepEqual(preds[2], preds[0]);
});

test('captureForRoster: never reads the target day or later, from the log or the profile', async () => {
  const store = await enrolled();
  const history = logged('2026-11-18', { '@me': { days: 10, score: 80 } });
  history.rounds['@me'].push({ date: '2026-11-18', cities: [PARIS, PARIS, PARIS, PARIS, PARIS], scores: [0, 0, 0, 0, 0] });
  const p = profile('2026-11-18', 10, 80);
  p['2026-11-19'] = { roundData: [1, 2, 3, 4, 5].map((round) => ({ round, score: 0, cityLat: PARIS.lat, cityLng: PARIS.lng })) };
  const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: p } });
  await captureForRoster({ store, uid: 'u1', roster: { me: 'me_user', rivals: [] }, history, nowMs: T('2026-11-17', 3, 17), fetchImpl });
  const [snap] = snapOf(store);
  assert.deepEqual([snap.players['@me'].t, snap.through], [800, '2026-11-17']);
});

test('captureForRoster: at or after 10:00 UTC the next day is no longer pre-game and nothing is fetched', async () => {
  const store = memStore();
  const { fetchImpl, calls } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: profile('2026-11-18', 10, 80) } });
  for (const now of [T('2026-11-17', 10, 0), T('2026-11-17', 23, 59)]) {
    const r = await captureForRoster({ store, uid: 'u1', roster: ROSTER, history: null, nowMs: now, fetchImpl });
    assert.deepEqual([r.target, r.status], ['2026-11-18', 'past-cutoff']);
  }
  assert.equal(calls.length, 0);
  assert.equal(store.map.size, 0);
});

test('captureForRoster: idempotent per puzzle; an undated file is recorded as such; a rewritten one gets its own snapshot', async () => {
  const store = await enrolled();
  const history = logged('2026-11-18', { '@me': { days: 10, score: 80 } });
  const roster = { me: 'me_user', rivals: [] };
  const profiles = { me_user: profile('2026-11-18', 10, 80) };
  let { fetchImpl } = upstream({ file: fileFor('2026-11-18', false), profiles });
  assert.equal((await captureForRoster({ store, uid: 'u1', roster, history, nowMs: T('2026-11-17', 3, 17), fetchImpl })).puzzleDated, false);
  assert.equal((await captureForRoster({ store, uid: 'u1', roster, history, nowMs: T('2026-11-17', 6, 17), fetchImpl })).status, 'exists');
  ({ fetchImpl } = upstream({ file: fileFor('2026-11-18', true), profiles }));
  assert.equal((await captureForRoster({ store, uid: 'u1', roster, history, nowMs: T('2026-11-17', 9, 17), fetchImpl })).status, 'exists');
  assert.equal(store.keys('snap/').length, 1);
  ({ fetchImpl } = upstream({ file: fileFor('2026-11-18', true).replace('-33.9249', '-34.5'), profiles }));
  assert.equal((await captureForRoster({ store, uid: 'u1', roster, history, nowMs: T('2026-11-17', 9, 17), fetchImpl })).status, 'captured');
  assert.equal(store.keys('snap/').length, 2);
  // The undated one is never scored until the played cities match it.
  const map = Object.fromEntries(snapOf(store).map((s) => [stats.snapshotId(s), s]));
  const undated = snapOf(store).find((s) => !s.puzzleDated);
  assert.equal(stats.canonicalSnapshots({ [stats.snapshotId(undated)]: undated }).size, 0);
  const played = CITIES.map(([lat, lng]) => ({ lat, lng }));
  assert.equal(stats.canonicalSnapshots(map, new Map([['2026-11-18', played]])).get('2026-11-18').takenAt, undated.takenAt);
});

test('captureForRoster: a failed profile waits for the next run; the last run captures it as partial, never as complete', async () => {
  const store = await enrolled();
  const history = logged('2026-11-18', { '@me': { days: 10, score: 80 }, r1: { days: 10, score: 60 }, r2: { days: 10, score: 40 } });
  const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: profile('2026-11-18', 10, 80), rival_one: new Error('timeout') } });
  const early = await captureForRoster({ store, uid: 'u1', roster: ROSTER, history, nowMs: T('2026-11-17', 6, 17), fetchImpl });
  assert.deepEqual([early.status, early.unread, store.keys('snap/').length], ['retry', 1, 0]);
  const last = await captureForRoster({ store, uid: 'u1', roster: ROSTER, history, nowMs: T('2026-11-17', 9, 17), fetchImpl });
  assert.deepEqual([last.status, last.complete, last.players, last.unread], ['captured', false, 3, 1]);
  const [snap] = snapOf(store);
  assert.deepEqual(snap.unread, ['r1']);
  assert.equal(stats.canonicalSnapshots({ [stats.snapshotId(snap)]: snap }).size, 0, 'partial is not scored by default');
});

test('captureForRoster: no puzzle, an unreadable one or nobody predictable stores nothing', async () => {
  for (const [file, history, status] of [
    [null, null, 'puzzle-unavailable'],
    ['const cities = [{ lat: 1, lng: 2 }];', null, 'puzzle-unreadable'],
    [fileFor('2026-11-18'), null, 'no-prediction'],
  ]) {
    const store = memStore();
    const { fetchImpl } = upstream({ file, profiles: { me_user: profile('2026-11-18', 0, 80) } });
    const r = await captureForRoster({ store, uid: 'u1', roster: { me: 'me_user', rivals: [] }, history, nowMs: T('2026-11-17', 9, 17), fetchImpl });
    assert.equal(r.status, status);
    assert.equal(store.map.size, 0);
  }
});

async function enrol(store, uid, history) {
  await store.setJSON(rosterKey(uid), { ...ROSTER, updatedAt: 'x' });
  await store.setJSON(historyKey(uid), { at: history.at, history: history.history });
}

test('captureRun: only allowlisted, active accounts; records the outcome; an unset allowlist turns it off', async () => {
  const store = memStore();
  const history = logged('2026-11-18', { '@me': { days: 10, score: 80 }, r1: { days: 10, score: 60 }, r2: { days: 10, score: 40 } });
  await enrol(store, 'owner', history);
  await enrol(store, 'stranger', history);
  await enrol(store, 'quitter', history);
  await store.setJSON(optoutKey('quitter'), { at: 'x' });
  const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: profile('2026-11-18', 3, 80), rival_one: profile('2026-11-18', 3, 60) } });
  assert.deepEqual(await captureRun({ store, nowMs: T('2026-11-17', 6, 17), fetchImpl, allowlist: '' }), { results: [], disabled: true, swept: 0 });
  const run = await captureRun({ store, nowMs: T('2026-11-17', 6, 17), fetchImpl, allowlist: 'owner, quitter' });
  assert.deepEqual(run.results.map((r) => [r.uid, r.status]), [['owner', 'captured']]);
  assert.deepEqual(store.keys('snap/').map((k) => k.split('/')[1]), ['owner']);
  const status = await store.get(statusKey('owner'));
  assert.deepEqual([status.status, status.target, status.complete], ['captured', '2026-11-18', true]);
  assert.equal(await store.get(statusKey('quitter')), null);
  // A second run the same morning stores nothing new.
  await captureRun({ store, nowMs: T('2026-11-17', 9, 17), fetchImpl, allowlist: 'owner' });
  assert.equal(store.keys('snap/').length, 1);
  assert.equal((await store.get(statusKey('owner'))).status, 'exists');
});

test('captureRun: a capture finishing after the account turned capture off removes what it wrote', async () => {
  const store = memStore();
  const history = logged('2026-11-18', { '@me': { days: 10, score: 80 } });
  await enrol(store, 'owner', history);
  store.onSet = async (key) => { if (key.startsWith('snap/')) { store.onSet = null; await store.setJSON(optoutKey('owner'), { at: 'x' }); } };
  const { fetchImpl } = upstream({ file: fileFor('2026-11-18'), profiles: { me_user: profile('2026-11-18', 10, 80), rival_one: profile('2026-11-18', 10, 60) } });
  const run = await captureRun({ store, nowMs: T('2026-11-17', 6, 17), fetchImpl, allowlist: 'owner' });
  assert.equal(run.results[0].status, 'withdrawn');
  assert.deepEqual(store.keys('snap/'), []);
  assert.equal(await store.get(statusKey('owner')), null);
});

test('captureRun: a deleted account\'s marker and anything left under it are swept after a day, enabled or not', async () => {
  const store = memStore();
  await store.setJSON(goneKey('old'), { at: new Date(T('2026-11-15', 9)).toISOString() });
  await store.setJSON(snapKey('old', '2026-11-16', 'abc'), { x: 1 });
  await store.setJSON(rosterKey('old'), { me: null, rivals: [] });
  await store.setJSON(goneKey('recent'), { at: new Date(T('2026-11-17', 5)).toISOString() });
  const run = await captureRun({ store, nowMs: T('2026-11-17', 6, 17), fetchImpl: async () => { throw new Error('no fetch'); }, allowlist: '' });
  assert.equal(run.swept, 1);
  assert.deepEqual(store.keys(), [goneKey('recent')]);
  assert.ok(GONE_TTL_MS >= 3600000);
});

test('sanitizeRoster: every rival by id, usernames where usable, bounded', () => {
  assert.equal(sanitizeRoster(null), null);
  assert.equal(sanitizeRoster({ me: 'a' }), null);
  assert.deepEqual(sanitizeRoster({ me: 'bad name', rivals: [] }), { me: null, rivals: [] });
  assert.deepEqual(sanitizeRoster({ me: 'me', rivals: [{ id: 'r1', username: 'u1' }, { id: 'r1', username: 'dup' }, { id: 'bad id', username: 'x' },
    { id: 'r2', username: 'has space' }, { id: 'r3' }, 'junk'] }), { me: 'me', rivals: [{ id: 'r1', username: 'u1' }, { id: 'r2', username: null }, { id: 'r3', username: null }] });
  assert.equal(sanitizeRoster({ me: null, rivals: Array.from({ length: 80 }, (_, i) => ({ id: 'r' + i })) }).rivals.length, 60);
});

function req(method, { origin = 'https://shevato.com', token, body, query = '' } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request('https://shevato.com/.netlify/functions/maptap-snapshots' + query, { method, headers, body });
}
const GOOD = 'good-token-for-owner-0123456789';
const OTHER = 'good-token-for-other-0123456789';
const registration = () => { const h = logged('2026-11-18', { '@me': { days: 10, score: 80 } }); return { ...ROSTER, history: h.history }; };

test('handleSnapshots: refuses other origins, missing or invalid tokens; reading and registering need the allowlist', async () => {
  const store = memStore();
  const { fetchImpl } = upstream({ tokens: { [GOOD]: 'owner', [OTHER]: 'someone' } });
  const opts = { store, allowlist: 'owner', fetchImpl };
  assert.equal((await handleSnapshots(req('GET', { origin: 'https://evil.example', token: GOOD }), opts)).status, 403);
  assert.equal((await handleSnapshots(req('DELETE', { origin: 'https://evil.example', token: GOOD }), opts)).status, 403);
  assert.equal((await handleSnapshots(req('GET', {}), opts)).status, 401);
  assert.equal((await handleSnapshots(req('DELETE', {}), opts)).status, 401);
  assert.equal((await handleSnapshots(req('GET', { token: 'not-a-valid-token-at-all-xx' }), opts)).status, 401);
  assert.equal((await handleSnapshots(req('GET', { token: OTHER }), opts)).status, 403);
  assert.equal((await handleSnapshots(req('PUT', { token: OTHER, body: JSON.stringify(registration()) }), opts)).status, 403);
  assert.equal((await handleSnapshots(req('POST', { token: GOOD }), opts)).status, 405);
  assert.equal(store.map.size, 0);
});

test('handleSnapshots: register, read own data only, opt out (idempotent), refuse re-registering until opted back in', async () => {
  const store = memStore();
  const { fetchImpl } = upstream({ tokens: { [GOOD]: 'owner' } });
  const opts = { store, allowlist: 'owner', fetchImpl };
  assert.equal((await handleSnapshots(req('PUT', { token: GOOD, body: '{' }), opts)).status, 400);
  assert.equal((await handleSnapshots(req('PUT', { token: GOOD, body: JSON.stringify({ rivals: 'x' }) }), opts)).status, 400);
  assert.equal((await handleSnapshots(req('PUT', { token: GOOD, body: JSON.stringify({ ...ROSTER, history: { days: {}, players: { x: [['bad']] } } }) }), opts)).status, 400);
  assert.equal((await handleSnapshots(req('PUT', { token: GOOD, body: 'x'.repeat(2 * 1024 * 1024 + 1) }), opts)).status, 413);
  const extra = registration(); extra.history.note = 'x'.repeat(1000); extra.secret = 'y';
  assert.equal((await handleSnapshots(req('PUT', { token: GOOD, body: JSON.stringify(extra) }), opts)).status, 200);
  assert.deepEqual(store.keys(), [historyKey('owner'), rosterKey('owner')]);
  assert.deepEqual(Object.keys((await store.get(historyKey('owner'))).history).sort(), ['days', 'players'], 'only the validated fields are stored');
  assert.deepEqual(Object.keys(await store.get(rosterKey('owner'))).sort(), ['me', 'rivals', 'updatedAt']);
  await store.setJSON(snapKey('owner', '2026-11-18', 'abc'), { not: 'a snapshot' });
  await store.setJSON(snapKey('someone', '2026-11-18', 'abc'), { not: 'theirs' });
  const got = await (await handleSnapshots(req('GET', { token: GOOD }), opts)).json();
  assert.deepEqual([got.snapshots, got.enabled, got.optedOut, got.lastRun], [{}, true, false, null]);

  // Off: everything of the owner's goes, a marker stays; twice is fine.
  for (let i = 0; i < 2; i++) assert.equal((await handleSnapshots(req('DELETE', { token: GOOD }), opts)).status, 200);
  assert.deepEqual(store.keys(), [optoutKey('owner'), snapKey('someone', '2026-11-18', 'abc')]);
  assert.equal((await handleSnapshots(req('PUT', { token: GOOD, body: JSON.stringify(registration()) }), opts)).status, 409);
  const off = await (await handleSnapshots(req('GET', { token: GOOD }), opts)).json();
  assert.deepEqual([off.enabled, off.optedOut], [false, true]);
  // On again, explicitly.
  assert.equal((await handleSnapshots(req('PUT', { token: GOOD, body: JSON.stringify({ ...registration(), optIn: true }) }), opts)).status, 200);
  assert.equal(await store.get(optoutKey('owner')), null);
});

test('handleSnapshots: account deletion removes everything (allowlisted or not), refuses a racing roster, and is idempotent', async () => {
  const store = memStore();
  const { fetchImpl } = upstream({ tokens: { [GOOD]: 'owner' } });
  await store.setJSON(rosterKey('owner'), { me: null, rivals: [] });
  await store.setJSON(historyKey('owner'), { at: 'x', history: {} });
  await store.setJSON(statusKey('owner'), { at: 'x' });
  await store.setJSON(optoutKey('owner'), { at: 'x' });
  await store.setJSON(snapKey('owner', '2026-11-18', 'abc'), { x: 1 });
  for (let i = 0; i < 2; i++) {
    const res = await handleSnapshots(req('DELETE', { token: GOOD, query: '?scope=account' }), { store, allowlist: '', fetchImpl });
    assert.equal(res.status, 200);
  }
  assert.deepEqual(store.keys(), [goneKey('owner')]);
  // A tab that missed the deletion cannot register again.
  const late = await handleSnapshots(req('PUT', { token: GOOD, body: JSON.stringify({ ...registration(), optIn: true }) }), { store, allowlist: 'owner', fetchImpl });
  assert.equal(late.status, 410);
  assert.deepEqual(store.keys(), [goneKey('owner')]);
});

test('handleSnapshots: a roster write that races a delete removes itself', async () => {
  const store = memStore();
  const { fetchImpl } = upstream({ tokens: { [GOOD]: 'owner' } });
  store.onSet = async (key) => { if (key === rosterKey('owner')) { store.onSet = null; await store.setJSON(goneKey('owner'), { at: 'x' }); } };
  const res = await handleSnapshots(req('PUT', { token: GOOD, body: JSON.stringify(registration()) }), { store, allowlist: 'owner', fetchImpl });
  assert.equal(res.status, 409);
  assert.deepEqual(store.keys(), [goneKey('owner')]);
});

test('uidFromIdToken: a failing or odd lookup is never a user', async () => {
  const bad = [async () => { throw new Error('down'); }, async () => ({ ok: true, json: async () => ({ users: [{ localId: 'x', disabled: true }] }) }),
    async () => ({ ok: true, json: async () => ({}) }), async () => ({ ok: false, json: async () => ({}) })];
  for (const f of bad) assert.equal(await uidFromIdToken('a-long-enough-token-value', f), null);
  assert.equal(await uidFromIdToken('short', async () => { throw new Error('must not be called'); }), null);
  assert.equal(SNAPSHOT_STORE, 'maptap-snapshots');
});
