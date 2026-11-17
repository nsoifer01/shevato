// MapTap Rivals pre-game prediction snapshots, captured on Netlify's
// scheduler so a forecast exists whether or not anyone opens the app.
//
// WHY A NETLIFY SCHEDULE. A day D can be played from 00:00 at UTC+14, which is
// 10:00 UTC on D-1 (stats.js preGameCutoffMs), so a pre-game forecast has to
// exist before then. GitHub's scheduler fires a free repository's jobs hours
// late (lib/fpl-archive-stage.mjs records 5 to 8 hours), Netlify's fires on
// time, and this site already runs scheduled functions and Blobs on it.
//
// WHAT RUNS. maptap-snapshot-capture.mjs at 03:17, 06:17 and 09:17 UTC. Each
// run targets D = tomorrow (UTC) for every enabled account's roster: it reads
// D's maptap.gg puzzle file, every rostered player's PUBLIC MapTap profile, and
// predicts D with the app's own predictor (stats.js, the code the card runs),
// from rounds dated before D only. The first run that succeeds stores the
// snapshot; later runs find it and stop. A run with a profile missing waits
// for the next one, except the last run before the cutoff, which captures the
// players it has.
//
// THE PUZZLE. maptap.gg dates a file (city ids naming the date) only a day or
// two ahead. A dated file is recorded `puzzleDated: true`. An undated one is
// still predicted, recorded `puzzleDated: false`, and counts only once the
// cities actually played that day are known to match its fingerprint
// (stats.js snapshotMatchesPuzzle): a file MapTap rewrites later, or last
// year's puzzle, is then excluded rather than mistaken for the day's.
//
// STORAGE, in the site-scoped `maptap-snapshots` store:
//   roster/<uid>                       { me, rivals: [{ id, username }], updatedAt }
//   snap/<uid>/<date>/<fingerprint>    one snapshot, written onlyIfNew
// One snapshot per (day, puzzle) and never overwritten, so the store grows by
// about one small JSON per enabled account per day.
//
// WHO. Only accounts listed in MAPTAP_SNAPSHOT_UIDS (comma-separated Firebase
// uids, a Netlify environment variable) can register a roster or read their
// snapshots, and only rosters of listed accounts are captured. Unset, the
// whole feature is off.

import stats from '../../../apps/maptap-rivals/js/stats.js';
import { originAllowed, json } from './tp-http.mjs';

const {
  parseDailyCitiesText, dailyFileIsFor, mapTapHistoryToRounds, roundsFromHistories,
  predictRoundsForPlayer, buildPredictionSnapshot, puzzleFingerprint, snapshotId,
  isPreGameInstant, preGameCutoffMs, sanitizeSnapshots, parseDateISO, PREDICTION_MODEL_VERSION,
} = stats;

export const SNAPSHOT_STORE = 'maptap-snapshots';
// The site's public Firebase web API key, the one firebase-config.js ships to
// every browser (asserted equal by the tests). It identifies the project to
// Google's token lookup; it is not a secret and grants nothing by itself.
export const FIREBASE_WEB_API_KEY = 'AIzaSyDlawczS-pufHS_Oi5LUeU_EzcwTFyU_2I';
export const TOKEN_LOOKUP_URL = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`;
export const PROFILE_URL = 'https://us-central1-jjexperiment-12af6.cloudfunctions.net/getPublicProfile';
export const DAILY_URL_BASE = 'https://maptap.gg/data/this_day_in_history/';
export const MAX_RIVALS = 60;
// Spacing of the scheduled runs (maptap-snapshot-capture.mjs): a run is the
// last before a cutoff when the next one would land after it.
export const RUN_INTERVAL_MS = 3 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const DAY_MS = 86400000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const rosterKey = (uid) => `roster/${uid}`;
export const snapPrefix = (uid, date) => `snap/${uid}/${date ? date + '/' : ''}`;
export const snapKey = (uid, date, fingerprint) => `${snapPrefix(uid, date)}${fingerprint}`;

export function allowlistFrom(value) {
  return new Set(String(value || '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function dailyFileUrl(iso) {
  const p = parseDateISO(iso);
  return p ? `${DAILY_URL_BASE}${MONTH_NAMES[p.month - 1]}${p.day}.js` : null;
}

// The day the run at `nowMs` captures: tomorrow in UTC. Its cutoff is 10:00
// UTC today, so the 03:17, 06:17 and 09:17 runs are all before it.
export function captureTargetFor(nowMs) {
  return new Date(Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS).toISOString().slice(0, 10);
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// MapTap usernames as the app stores them (normalizeMapTapUsername): no
// whitespace, no URL punctuation, bounded.
const USERNAME_RE = /^[^\s/?#\\"'<>]{1,64}$/;

// A roster as the app sends it, reduced to what capture needs. Null when it
// is not a roster at all; rivals with an unusable id or username are dropped.
export function sanitizeRoster(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const me = typeof body.me === 'string' && USERNAME_RE.test(body.me) ? body.me : null;
  if (!Array.isArray(body.rivals)) return null;
  const seen = new Set();
  const rivals = [];
  for (const r of body.rivals) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.id !== 'string' || !ID_RE.test(r.id) || seen.has(r.id)) continue;
    if (typeof r.username !== 'string' || !USERNAME_RE.test(r.username)) continue;
    seen.add(r.id);
    rivals.push({ id: r.id, username: r.username });
    if (rivals.length === MAX_RIVALS) break;
  }
  if (!me && !rivals.length) return null;
  return { me, rivals };
}

async function fetchText(fetchImpl, url, init) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

async function fetchHistory(fetchImpl, nickname) {
  const text = await fetchText(fetchImpl, PROFILE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { nickname } }),
  });
  const body = JSON.parse(text);
  const result = body && (body.result || body);
  if (!result || !result.success || !result.user) throw new Error('profile not found');
  return mapTapHistoryToRounds(result.user.gameHistory);
}

/**
 * Capture one account's snapshot of `target`, if it is still pre-game and not
 * already stored for the puzzle maptap.gg serves now. Returns a summary.
 */
export async function captureForRoster({ store, uid, roster, nowMs, fetchImpl = fetch, lastRun }) {
  const target = captureTargetFor(nowMs);
  if (!isPreGameInstant(target, nowMs)) return { uid, target, status: 'past-cutoff' };
  const final = typeof lastRun === 'boolean' ? lastRun : nowMs + RUN_INTERVAL_MS >= preGameCutoffMs(target);

  let src;
  try {
    src = await fetchText(fetchImpl, dailyFileUrl(target), { cache: 'no-store' });
  } catch (err) {
    return { uid, target, status: 'puzzle-unavailable', error: String(err && err.message) };
  }
  const cities = parseDailyCitiesText(src);
  if (!cities) return { uid, target, status: 'puzzle-unreadable' };
  const puzzleDated = dailyFileIsFor(src, target, null);
  const fingerprint = puzzleFingerprint(cities);
  if (await store.get(snapKey(uid, target, fingerprint))) return { uid, target, status: 'exists' };

  const players = [];
  if (roster.me) players.push({ key: '@me', username: roster.me });
  for (const r of roster.rivals) players.push({ key: r.id, username: r.username });
  const settled = await Promise.allSettled(players.map((p) => fetchHistory(fetchImpl, p.username)));
  const histories = {};
  const missing = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') histories[players[i].key] = s.value;
    else missing.push(players[i].key);
  });
  if (missing.length && !final) return { uid, target, status: 'retry', missing: missing.length };

  const order = players.map((p) => p.key).filter((k) => histories[k]);
  const rounds = roundsFromHistories(histories, order);
  let through = null;
  for (const key of order) for (const r of rounds[key]) {
    if (r.date < target && (!through || r.date > through)) through = r.date;
  }
  const snap = buildPredictionSnapshot({
    date: target,
    takenAtMs: nowMs,
    model: PREDICTION_MODEL_VERSION,
    source: 'scheduled',
    puzzleDated,
    through,
    cities,
    // Keys stand in for names: the server keeps no names, so two players on
    // exactly the same predicted total are placed by key, not by name.
    players: order.map((key) => {
      const pred = predictRoundsForPlayer(rounds[key], cities, target);
      return { key, name: key, scores: pred ? pred.scores : null };
    }),
  });
  if (!snap) return { uid, target, status: 'no-prediction', missing: missing.length };
  const res = await store.setJSON(snapKey(uid, target, fingerprint), snap, { onlyIfNew: true });
  if (res && res.modified === false) return { uid, target, status: 'exists' };
  return { uid, target, status: 'captured', puzzleDated, players: Object.keys(snap.players).length, missing: missing.length };
}

/** One scheduled run over every enabled account that registered a roster. */
export async function captureRun({ store, nowMs = Date.now(), fetchImpl = fetch, allowlist }) {
  const allowed = allowlist instanceof Set ? allowlist : allowlistFrom(allowlist);
  const results = [];
  if (!allowed.size) return { results, disabled: true };
  const { blobs } = await store.list({ prefix: 'roster/' });
  for (const { key } of blobs || []) {
    const uid = key.slice('roster/'.length);
    if (!allowed.has(uid)) continue;
    const roster = sanitizeRoster(await store.get(key, { type: 'json' }));
    if (!roster) continue;
    try {
      results.push(await captureForRoster({ store, uid, roster, nowMs, fetchImpl }));
    } catch (err) {
      results.push({ uid, status: 'failed', error: String(err && err.message) });
    }
  }
  return { results };
}

// The signed-in Firebase user behind an ID token, asked of Google's own token
// service (accounts:lookup) so this file holds no key material and verifies
// no signature itself. Null when the token is missing, invalid or expired.
export async function uidFromIdToken(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
  try {
    const res = await fetchImpl(TOKEN_LOOKUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const user = body && Array.isArray(body.users) ? body.users[0] : null;
    return user && typeof user.localId === 'string' && !user.disabled ? user.localId : null;
  } catch {
    return null;
  }
}

async function readSnapshots(store, uid) {
  const out = {};
  const { blobs } = await store.list({ prefix: snapPrefix(uid) });
  for (const { key } of blobs || []) {
    const snap = await store.get(key, { type: 'json' });
    if (snap && typeof snap === 'object') out[snapshotId(snap)] = snap;
  }
  // Exactly what the app accepts, nothing else.
  return sanitizeSnapshots(out);
}

/**
 * The account's own endpoint:
 *   GET     its stored snapshots   { snapshots: { '<date>@<takenAt>': snapshot } }
 *   PUT     register its roster    { me, rivals: [{ id, username }] }
 *   DELETE  remove its roster (capture stops) and every stored snapshot
 * Always a Firebase ID token for an allowlisted account, from this site.
 */
export async function handleSnapshots(request, { store, allowlist, fetchImpl = fetch }) {
  if (!originAllowed(request)) return json({ error: 'forbidden' }, 403);
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const uid = await uidFromIdToken(token, fetchImpl);
  if (!uid) return json({ error: 'unauthenticated' }, 401);
  const allowed = allowlist instanceof Set ? allowlist : allowlistFrom(allowlist);
  if (!allowed.has(uid)) return json({ error: 'not_enabled' }, 403);

  if (request.method === 'GET') return json({ snapshots: await readSnapshots(store, uid) }, 200);
  if (request.method === 'PUT') {
    let body;
    try { body = JSON.parse(await request.text()); } catch { return json({ error: 'bad_json' }, 400); }
    const roster = sanitizeRoster(body);
    if (!roster) return json({ error: 'bad_roster' }, 400);
    await store.setJSON(rosterKey(uid), { ...roster, updatedAt: new Date().toISOString() });
    return json({ ok: true, rivals: roster.rivals.length, me: !!roster.me }, 200);
  }
  if (request.method === 'DELETE') {
    await store.delete(rosterKey(uid));
    const { blobs } = await store.list({ prefix: snapPrefix(uid) });
    for (const { key } of blobs || []) await store.delete(key);
    return json({ ok: true, removed: (blobs || []).length }, 200);
  }
  return json({ error: 'method_not_allowed' }, 405);
}
