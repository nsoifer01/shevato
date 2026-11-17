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
// run targets D = tomorrow (UTC) for every enabled account's roster and
// predicts D with the app's own predictor (stats.js) from the app's own
// inputs: the round history the app uploaded (every player, including
// rivals with no MapTap username, exactly as the card reads it), plus each
// newer day from the players' PUBLIC MapTap profiles that the upload does not
// hold yet (what the app's next sync would add). A profile that returns fewer
// days than the app logged loses nothing. Rounds dated D or later are never
// read. The first run that succeeds stores the snapshot; later runs find it
// and stop. A run that cannot read a profile waits for the next one, except
// the last run before the cutoff, which captures anyway and records the
// players it could not refresh in `unread`: that snapshot is partial and is
// not scored as the card's leaderboard (stats.js canonicalSnapshots).
//
// THE PUZZLE. maptap.gg dates a file (city ids naming the date) only a day or
// two ahead. A dated file is recorded `puzzleDated: true`. An undated one is
// still predicted, recorded `puzzleDated: false`, and scored only once the
// cities actually played that day are known to match its fingerprint.
//
// STORAGE, in the site-scoped `maptap-snapshots` store, strong consistency:
//   roster/<uid>                       { me, rivals: [{ id, username|null }], updatedAt }
//   history/<uid>                      the app's encoded round history (stats.js encodeRoundsHistory)
//   snap/<uid>/<date>/<fingerprint>    one snapshot, written onlyIfNew
//   status/<uid>                       the last run's outcome, for the app to show
//   optout/<uid>                       { at } after the account turned capture off
//   gone/<uid>                         { at } for a day after account deletion
// One snapshot per (day, puzzle), never overwritten.
//
// WHO. Only accounts listed in MAPTAP_SNAPSHOT_UIDS (comma-separated Firebase
// uids, a Netlify environment variable) can register a roster or read their
// snapshots, and only rosters of listed accounts are captured. Any signed-in
// account can delete its own data at any time, listed or not: DELETE turns
// capture off (removes everything and leaves an opt-out marker that refuses
// a roster until the account turns it back on), DELETE ?scope=account removes
// everything including that marker (account deletion runs it, while the
// account still exists). Account deletion leaves only `gone/<uid>`, which
// refuses a roster from a tab that had not noticed the deletion yet; the next
// scheduled run more than a day later sweeps it together with anything else
// still under that uid. A roster write re-checks both markers after it lands
// and removes itself if either appeared, and so does a snapshot write, so
// neither a racing tab nor a running capture can recreate data.

import stats from '../../../apps/maptap-rivals/js/stats.js';
import { originAllowed, json } from './tp-http.mjs';

const {
  parseDailyCitiesText, dailyFileIsFor, mapTapHistoryToRounds, roundsFromHistories,
  predictRoundsForPlayer, buildPredictionSnapshot, puzzleFingerprint, snapshotId,
  isPreGameInstant, preGameCutoffMs, sanitizeSnapshots, parseDateISO, PREDICTION_MODEL_VERSION,
  decodeRoundsHistory, mergeLoggedAndFresh,
} = stats;

export const SNAPSHOT_STORE = 'maptap-snapshots';
const DAY_MS = 86400000;
// The site's public Firebase web API key, the one firebase-config.js ships to
// every browser (asserted equal by the tests). It identifies the project to
// Google's token lookup; it is not a secret and grants nothing by itself.
export const FIREBASE_WEB_API_KEY = 'AIzaSyDlawczS-pufHS_Oi5LUeU_EzcwTFyU_2I';
export const TOKEN_LOOKUP_URL = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`;
export const PROFILE_URL = 'https://us-central1-jjexperiment-12af6.cloudfunctions.net/getPublicProfile';
export const DAILY_URL_BASE = 'https://maptap.gg/data/this_day_in_history/';
export const MAX_RIVALS = 60;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Spacing of the scheduled runs (maptap-snapshot-capture.mjs): a run is the
// last before a cutoff when the next one would land after it.
export const RUN_INTERVAL_MS = 3 * 3600 * 1000;
// Scheduled functions get 30 s: the puzzle and the profiles (fetched in
// parallel) each get a third of it.
const FETCH_TIMEOUT_MS = 10000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const rosterKey = (uid) => `roster/${uid}`;
export const historyKey = (uid) => `history/${uid}`;
export const statusKey = (uid) => `status/${uid}`;
export const optoutKey = (uid) => `optout/${uid}`;
export const goneKey = (uid) => `gone/${uid}`;
export const GONE_TTL_MS = DAY_MS;
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
const username = (v) => (typeof v === 'string' && USERNAME_RE.test(v) ? v : null);

// A roster as the app sends it: the user's MapTap username (or null) and
// every rival by id, with a username where the app has one. A rival without
// a usable id is dropped; an unusable username is treated as none. Null when
// it is not a roster at all.
export function sanitizeRoster(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.rivals)) return null;
  const seen = new Set();
  const rivals = [];
  for (const r of body.rivals) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    rivals.push({ id: r.id, username: username(r.username) });
    if (rivals.length === MAX_RIVALS) break;
  }
  return { me: username(body.me), rivals };
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

const blocked = async (store, uid) => !!(await store.get(optoutKey(uid))) || !!(await store.get(goneKey(uid)));
const active = async (store, uid) => !!(await store.get(rosterKey(uid))) && !(await blocked(store, uid));

/**
 * Capture one account's snapshot of `target`, if it is still pre-game and not
 * already stored for the puzzle maptap.gg serves now. Returns a summary.
 */
export async function captureForRoster({ store, uid, roster, history, nowMs, fetchImpl = fetch, lastRun }) {
  const target = captureTargetFor(nowMs);
  if (!isPreGameInstant(target, nowMs)) return { target, status: 'past-cutoff' };
  const final = typeof lastRun === 'boolean' ? lastRun : nowMs + RUN_INTERVAL_MS >= preGameCutoffMs(target);

  let src;
  try {
    src = await fetchText(fetchImpl, dailyFileUrl(target), { cache: 'no-store' });
  } catch (err) {
    return { target, status: 'puzzle-unavailable', error: String(err && err.message) };
  }
  const cities = parseDailyCitiesText(src);
  if (!cities) return { target, status: 'puzzle-unreadable' };
  const puzzleDated = dailyFileIsFor(src, target, null);
  const fingerprint = puzzleFingerprint(cities);
  if (await store.get(snapKey(uid, target, fingerprint))) return { target, status: 'exists', puzzleDated };

  // Every player the app has, the user first (the order the app reads the
  // day map in). Those with a username are refreshed from MapTap.
  const players = [{ key: '@me', username: roster.me }]
    .concat(roster.rivals.map((r) => ({ key: r.id, username: r.username })));
  const withName = players.filter((p) => p.username);
  const settled = await Promise.allSettled(withName.map((p) => fetchHistory(fetchImpl, p.username)));
  const fresh = {};
  const unread = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') fresh[withName[i].key] = s.value;
    else unread.push(withName[i].key);
  });
  if (unread.length && !final) return { target, status: 'retry', unread: unread.length };

  const logged = (history && history.rounds) || {};
  const freshRounds = roundsFromHistories(fresh, players.map((p) => p.key).filter((k) => fresh[k]));
  const days = (history && history.days) || {};
  let through = null;
  const predictions = players.map(({ key }) => {
    const rounds = mergeLoggedAndFresh(logged[key], freshRounds[key], days);
    for (const r of rounds) if (r.date < target && (!through || r.date > through)) through = r.date;
    const pred = predictRoundsForPlayer(rounds, cities, target);
    return { key, scores: pred ? pred.scores : null };
  });
  const snap = buildPredictionSnapshot({
    date: target,
    takenAtMs: nowMs,
    model: PREDICTION_MODEL_VERSION,
    source: 'scheduled',
    puzzleDated,
    through,
    cities,
    roster: players.length,
    unread,
    historyAt: (history && history.at) || null,
    players: predictions,
  });
  if (!snap) return { target, status: 'no-prediction', unread: unread.length };
  const key = snapKey(uid, target, fingerprint);
  const res = await store.setJSON(key, snap, { onlyIfNew: true });
  if (res && res.modified === false) return { target, status: 'exists', puzzleDated };
  // The account may have turned capture off, or been deleted, while this run
  // was working: then what it just wrote must not survive.
  if (!(await active(store, uid))) {
    await store.delete(key);
    return { target, status: 'withdrawn' };
  }
  return {
    target, status: 'captured', puzzleDated, complete: unread.length === 0,
    players: Object.keys(snap.players).length, roster: players.length, unread: unread.length,
  };
}

/** One scheduled run over every enabled account that registered a roster. */
export async function captureRun({ store, nowMs = Date.now(), fetchImpl = fetch, allowlist }) {
  const allowed = allowlist instanceof Set ? allowlist : allowlistFrom(allowlist);
  const results = [];
  // Deleted accounts first, whether or not capture is enabled: once a marker
  // is a day old, it and anything still under that uid are removed.
  const swept = await sweepDeleted(store, nowMs);
  if (!allowed.size) return { results, disabled: true, swept };
  const { blobs } = await store.list({ prefix: 'roster/' });
  for (const { key } of blobs || []) {
    const uid = key.slice('roster/'.length);
    if (!allowed.has(uid) || (await blocked(store, uid))) continue;
    let result;
    try {
      const roster = sanitizeRoster(await store.get(key, { type: 'json' }));
      if (!roster) continue;
      const raw = await store.get(historyKey(uid), { type: 'json' });
      const rounds = raw ? decodeRoundsHistory(raw.history) : null;
      const history = rounds ? { rounds, days: raw.history.days, at: raw.at || null } : null;
      result = await captureForRoster({ store, uid, roster, history, nowMs, fetchImpl });
    } catch (err) {
      result = { status: 'failed', error: String(err && err.message) };
    }
    results.push({ uid, ...result });
    // What the app shows as "last scheduled capture", and what a failed run
    // leaves behind to be seen. Not for an account that left mid-run.
    if (result.status !== 'withdrawn' && (await active(store, uid))) {
      await store.setJSON(statusKey(uid), { at: new Date(nowMs).toISOString(), ...result, error: undefined });
    }
  }
  return { results, swept };
}

async function sweepDeleted(store, nowMs) {
  let swept = 0;
  const { blobs } = await store.list({ prefix: 'gone/' });
  for (const { key } of blobs || []) {
    const marker = await store.get(key, { type: 'json' });
    const at = marker && Date.parse(marker.at);
    if (Number.isFinite(at) && nowMs - at < GONE_TTL_MS) continue;
    const uid = key.slice('gone/'.length);
    await removeAll(store, uid, { keepOptout: false });
    await store.delete(key);
    swept++;
  }
  return swept;
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

// Everything stored for the account, the opt-out marker included or not.
async function removeAll(store, uid, { keepOptout }) {
  let removed = 0;
  for (const key of [rosterKey(uid), historyKey(uid), statusKey(uid)].concat(keepOptout ? [] : [optoutKey(uid)])) {
    if (await store.get(key)) removed++;
    await store.delete(key);
  }
  const { blobs } = await store.list({ prefix: snapPrefix(uid) });
  for (const { key } of blobs || []) { await store.delete(key); removed++; }
  return removed;
}

/**
 * The account's own endpoint, always with a Firebase ID token, from this site:
 *   GET     (enabled accounts) { snapshots, enabled, optedOut, lastRun }
 *   PUT     (enabled accounts) register the roster and round history:
 *           { me, rivals: [{ id, username }], history, optIn? }; refused with
 *           409 after an opt-out unless optIn is true
 *   DELETE  (any account) turn capture off: remove roster, history, status and
 *           every snapshot, and keep an opt-out marker
 *   DELETE ?scope=account  (any account) remove all of it, marker included
 * Both deletes are idempotent.
 */
export async function handleSnapshots(request, { store, allowlist, fetchImpl = fetch }) {
  if (!originAllowed(request)) return json({ error: 'forbidden' }, 403);
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const uid = await uidFromIdToken(token, fetchImpl);
  if (!uid) return json({ error: 'unauthenticated' }, 401);

  if (request.method === 'DELETE') {
    const scope = new URL(request.url).searchParams.get('scope');
    if (scope === 'account') {
      // The marker first, so a roster write racing this delete is refused or
      // removes itself; then everything else.
      await store.setJSON(goneKey(uid), { at: new Date().toISOString() });
      return json({ ok: true, removed: await removeAll(store, uid, { keepOptout: false }) }, 200);
    }
    const removed = await removeAll(store, uid, { keepOptout: true });
    await store.setJSON(optoutKey(uid), { at: new Date().toISOString() });
    return json({ ok: true, removed, optedOut: true }, 200);
  }

  const allowed = allowlist instanceof Set ? allowlist : allowlistFrom(allowlist);
  if (!allowed.has(uid)) return json({ error: 'not_enabled' }, 403);

  if (request.method === 'GET') {
    const optedOut = !!(await store.get(optoutKey(uid)));
    const roster = await store.get(rosterKey(uid));
    const lastRun = await store.get(statusKey(uid), { type: 'json' });
    return json({ snapshots: await readSnapshots(store, uid), enabled: !optedOut && !!roster, optedOut, lastRun: lastRun || null }, 200);
  }
  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400); }
    const roster = sanitizeRoster(body);
    const rounds = body && body.history !== undefined ? decodeRoundsHistory(body.history) : {};
    if (!roster || !rounds) return json({ error: 'bad_roster' }, 400);
    if (await store.get(goneKey(uid))) return json({ error: 'deleted' }, 410);
    if (await store.get(optoutKey(uid))) {
      if (body.optIn !== true) return json({ error: 'opted_out' }, 409);
      await store.delete(optoutKey(uid));
    }
    const at = new Date().toISOString();
    // Only the two validated fields are kept, whatever else the body carried.
    if (body.history !== undefined) {
      await store.setJSON(historyKey(uid), { at, history: { days: body.history.days, players: body.history.players } });
    }
    await store.setJSON(rosterKey(uid), { ...roster, updatedAt: at });
    // A delete or opt-out that landed while this was writing wins.
    if (await blocked(store, uid)) {
      await store.delete(rosterKey(uid));
      await store.delete(historyKey(uid));
      return json({ error: 'withdrawn' }, 409);
    }
    return json({ ok: true, rivals: roster.rivals.length, players: Object.keys(rounds).length }, 200);
  }
  return json({ error: 'method_not_allowed' }, 405);
}
