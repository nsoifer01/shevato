// The live-season deadline archive: what FPL served, when, and for which
// deadline, kept so the season can be scored afterwards without leakage.
//
// WHY THIS EXISTS
//
// Every accuracy number this project has is a replay of a finished season from
// a third-party archive, and the one honest official baseline (FPL's own
// `ep_next`) cannot be recovered afterwards: the archive's `xP` column is the
// value AFTER the gameweek (haul weeks read 6.78 against 2.96 the week before).
// The public endpoints only ever show the present, so a deadline that is not
// captured before it passes is lost for good. This module is the pure part of
// the capture: naming, shape checks, the manifest and the decision of WHEN to
// capture. The network and the filesystem live in scripts/archive-snapshot.mjs.
//
// Everything here is deterministic in its inputs (`now` is always passed in) so
// the gating can be tested against a bootstrap and a clock.

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ARCHIVE_FORMAT = 'fpl-planner-archive/1';
export const FPL_API = 'https://fantasy.premierleague.com/api/';
export const USER_AGENT = 'shevato-fpl-archive/1.0 (+https://shevato.com/apps/fpl-planner/; public deadline archive, hourly at most)';

const HOUR = 3600e3;

/** Gating defaults, in hours. See decideCaptures. */
export const GATE = Object.freeze({
  preWindowHours: 26,
  preSpacingHours: 6,
  finalHours: 2,
  postHours: 3,
});

/** The endpoints a pre or post capture takes, and the short name each is filed under. */
export const ENDPOINTS = Object.freeze([
  { name: 'bootstrap', path: 'bootstrap-static/' },
  { name: 'fixtures', path: 'fixtures/' },
  { name: 'event-status', path: 'event-status/' },
]);
export const livePath = (gw) => `event/${gw}/live/`;

export const PHASES = Object.freeze(['pre', 'post', 'live', 'adhoc']);

/* ------------------------------------------------------------- the season */

/**
 * "2026-27" from the first deadline of the season. The bootstrap carries no
 * season name; the first event's deadline year is the season's first year
 * (August), which is what every other season label in this app means.
 */
export function seasonLabelFrom(bootstrap) {
  const first = bootstrap && Array.isArray(bootstrap.events) && bootstrap.events[0];
  const ms = first ? Date.parse(first.deadline_time) : NaN;
  if (!Number.isFinite(ms)) throw new Error('cannot derive a season label: events[0].deadline_time is missing');
  const y = new Date(ms).getUTCFullYear();
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export const releaseTagFor = (season) => `fpl-archive-${season}`;

/* ------------------------------------------------------------ shape checks */

/**
 * FPL answers with a plain-text "The game is being updated." (usually a 503,
 * occasionally a 200) while it rolls a gameweek over. That body must never be
 * archived as if it were a payload.
 */
export function isGameUpdating(text) {
  return /the game is being updated/i.test(String(text || '').slice(0, 400));
}

/**
 * Throws with a reason when `body` is not the shape `name` must have. These are
 * the fields the planner and the scorecard read, so a payload missing them is
 * worthless to archive and almost certainly an error page in disguise.
 */
export function assertShape(name, body) {
  const fail = (why) => { throw new Error(`${name}: refused, ${why}`); };
  if (name === 'bootstrap') {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('not an object');
    for (const k of ['elements', 'events', 'teams']) {
      if (!Array.isArray(body[k]) || body[k].length === 0) fail(`${k} is not a non-empty array`);
    }
    if (body.teams.length !== 20) fail(`${body.teams.length} teams, expected 20`);
    if (!body.events.every((e) => Number.isInteger(e.id) && typeof e.deadline_time === 'string')) {
      fail('an event has no id or deadline_time');
    }
    const e = body.elements[0];
    for (const k of ['id', 'team', 'element_type', 'now_cost', 'total_points']) {
      if (!(k in e)) fail(`elements carry no ${k}`);
    }
  } else if (name === 'fixtures') {
    if (!Array.isArray(body) || body.length === 0) fail('not a non-empty array');
    if (!body.every((f) => Number.isInteger(f.id) && Number.isInteger(f.team_h) && Number.isInteger(f.team_a))) {
      fail('a fixture has no id or teams');
    }
  } else if (name === 'event-status') {
    if (!body || !Array.isArray(body.status)) fail('status is not an array');
  } else if (name === 'live') {
    if (!body || !Array.isArray(body.elements) || body.elements.length === 0) fail('elements is not a non-empty array');
    if (!body.elements.every((e) => Number.isInteger(e.id) && e.stats && typeof e.stats === 'object')) {
      fail('an element has no id or stats');
    }
  } else {
    fail('unknown endpoint');
  }
  return body;
}

/** Parse a raw response body as `name`, refusing the update notice and any bad shape. */
export function parsePayload(name, text) {
  if (isGameUpdating(text)) {
    const err = new Error(`${name}: refused, FPL says the game is being updated`);
    err.gameUpdating = true;
    throw err;
  }
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${name}: refused, the body is not JSON`); }
  return assertShape(name, body);
}

/* ------------------------------------------------------------------ naming */

/** 2026-10-09T15:30:12.345Z -> 20261009T153012Z (ISO 8601 basic, safe as an asset name). */
export function compactStamp(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`not a timestamp: ${iso}`);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/**
 * `pre-gw06-20261009T153012Z-bootstrap.json.gz`. The season is the directory
 * (and the release), so the file name alone is unique within it.
 */
export function snapshotFileName({ phase, gw, capturedAt, endpoint }) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase ${phase}`);
  if (!Number.isInteger(gw) || gw < 0) throw new Error(`bad gameweek ${gw}`);
  if (!/^[a-z-]+$/.test(endpoint)) throw new Error(`bad endpoint ${endpoint}`);
  return `${phase}-gw${String(gw).padStart(2, '0')}-${compactStamp(capturedAt)}-${endpoint}.json.gz`;
}

const NAME_RE = /^(pre|post|live|adhoc)-gw(\d{2,})-(\d{8}T\d{6}Z)-([a-z-]+)\.json\.gz$/;
export function parseSnapshotFileName(name) {
  const m = NAME_RE.exec(name);
  return m ? { phase: m[1], gw: Number(m[2]), stamp: m[3], endpoint: m[4] } : null;
}

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * One archived response. `raw` is the body exactly as served, so `sha256(raw)`
 * re-verifies it; `capturedAt` is this machine's clock and `serverDate` FPL's
 * own Date header, kept separately because the leakage guard trusts neither
 * alone.
 */
export function buildRecord({ endpoint, url, phase, gw, deadline, capturedAt, serverDate, season, raw }) {
  return {
    archive: ARCHIVE_FORMAT,
    season,
    endpoint,
    url,
    phase,
    gw,
    deadline: deadline || null,
    capturedAt,
    serverDate: serverDate || null,
    sha256: sha256(raw),
    bytes: Buffer.byteLength(raw, 'utf8'),
    raw,
  };
}

export const encodeRecord = (record) => gzipSync(Buffer.from(JSON.stringify(record), 'utf8'), { level: 9 });

/**
 * Write one encoded record with an exclusive create ('wx'): a file that already
 * exists is an error, never a replace. The archive's whole value is that a
 * deadline payload, once captured, is the payload that was served.
 */
export function writeSnapshotFile(dir, file, buf) {
  writeFileSync(join(dir, file), buf, { flag: 'wx' });
}

/** Decode a .json.gz record, re-verify its hash and return { meta, body }. */
export function decodeRecord(buf) {
  const record = JSON.parse(gunzipSync(buf).toString('utf8'));
  if (record.archive !== ARCHIVE_FORMAT) throw new Error(`not an archive record (${record.archive})`);
  if (sha256(record.raw) !== record.sha256) throw new Error(`sha256 mismatch in ${record.endpoint} captured ${record.capturedAt}`);
  const { raw, ...meta } = record;
  return { meta, body: JSON.parse(raw) };
}

/* ---------------------------------------------------------------- manifest */

export function emptyManifest(season) {
  return { archive: ARCHIVE_FORMAT, season, releaseTag: releaseTagFor(season), entries: [] };
}

/**
 * Add one capture to the manifest, deduplicated by content. If a payload with
 * the same sha256 is already stored, the new entry is a POINTER (`file: null`,
 * `sameAs` the stored file): the capture is still recorded, with its own time
 * and phase, but the bytes are not stored twice. Returns { manifest, store },
 * where `store` says whether the caller has to write the file.
 */
export function addToManifest(manifest, entry) {
  const stored = manifest.entries.find((e) => e.sha256 === entry.sha256 && e.file);
  const next = stored
    ? { ...entry, file: null, sameAs: stored.file, gzBytes: 0 }
    : { ...entry, sameAs: null };
  if (manifest.entries.some((e) => e.file && next.file && e.file === next.file)) {
    throw new Error(`manifest already lists ${next.file}`);
  }
  return { manifest: { ...manifest, entries: [...manifest.entries, next] }, store: !stored };
}

/**
 * The manifest on the release is replaced on every capture, so the new one has
 * to contain every entry of the old one, unchanged and in order. Anything else
 * would be the archive forgetting a snapshot.
 */
export function assertAppendOnly(before, after) {
  if (!before) return;
  if (after.entries.length < before.entries.length) throw new Error('the manifest lost entries');
  before.entries.forEach((e, i) => {
    if (JSON.stringify(e) !== JSON.stringify(after.entries[i])) {
      throw new Error(`manifest entry ${i} (${e.file || e.sameAs}) changed`);
    }
  });
}

/** The stored file a manifest entry's bytes live in (itself, or the one it points at). */
export const storedFileOf = (entry) => entry.file || entry.sameAs;

/* ----------------------------------------------------------------- gating */

/** Events sorted by deadline, with the deadline parsed. */
export function deadlinesOf(bootstrap) {
  return bootstrap.events
    .map((e) => ({ gw: e.id, deadline: e.deadline_time, ms: Date.parse(e.deadline_time), finished: !!e.finished, dataChecked: !!e.data_checked }))
    .filter((e) => Number.isFinite(e.ms))
    .sort((a, b) => a.ms - b.ms);
}

/** The first deadline strictly after `now`, and the last one at or before it. */
export function deadlineContext(bootstrap, now) {
  const all = deadlinesOf(bootstrap);
  const t = Date.parse(now);
  const next = all.find((e) => e.ms > t) || null;
  const prev = [...all].reverse().find((e) => e.ms <= t) || null;
  return { next, prev, all };
}

const capturesOf = (manifest, phase, gw) => (manifest ? manifest.entries : [])
  .filter((e) => e.phase === phase && e.gw === gw && e.endpoint === (phase === 'live' ? 'live' : 'bootstrap'))
  .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));

/**
 * Which captures this run should make. Pure: the bootstrap, the manifest and a
 * clock in, a list of { phase, gw, deadline, reason } out (empty = nothing to
 * do, with `idle` saying why).
 *
 * - pre: the next deadline is within `preWindowHours`, and either no pre
 *   capture exists for it, or the newest is `preSpacingHours` old, or we are in
 *   the final `finalHours` and none was taken inside them. Hourly runs then
 *   land roughly at T-25h, T-19h, T-13h, T-7h and twice in the final two hours.
 * - post: a deadline passed less than `postHours` ago and no post capture
 *   exists for that gameweek.
 * - live: the newest finished, data_checked gameweek has no live capture yet.
 */
export function decideCaptures({ bootstrap, manifest, now, gate = GATE }) {
  const t = Date.parse(now);
  const { next, prev, all } = deadlineContext(bootstrap, now);
  const out = [];
  const notes = [];

  if (next) {
    const lead = (next.ms - t) / HOUR;
    if (lead <= gate.preWindowHours) {
      const pre = capturesOf(manifest, 'pre', next.gw);
      const newest = pre.length ? Date.parse(pre[pre.length - 1].capturedAt) : null;
      const inFinal = lead <= gate.finalHours;
      const finalDone = pre.some((e) => Date.parse(e.capturedAt) >= next.ms - gate.finalHours * HOUR);
      let reason = null;
      if (newest === null) reason = `first pre capture, ${lead.toFixed(1)}h before the GW${next.gw} deadline`;
      else if (inFinal && !finalDone) reason = `final ${gate.finalHours}h before the GW${next.gw} deadline and none taken inside them`;
      else if ((t - newest) / HOUR >= gate.preSpacingHours) reason = `newest pre capture is ${((t - newest) / HOUR).toFixed(1)}h old`;
      if (reason) out.push({ phase: 'pre', gw: next.gw, deadline: next.deadline, reason });
      else notes.push(`GW${next.gw} pre: newest capture ${((t - newest) / HOUR).toFixed(1)}h old, ${lead.toFixed(1)}h to the deadline`);
    } else {
      notes.push(`GW${next.gw} deadline is ${lead.toFixed(1)}h away, outside the ${gate.preWindowHours}h pre window`);
    }
  }

  if (prev) {
    const since = (t - prev.ms) / HOUR;
    if (since <= gate.postHours && capturesOf(manifest, 'post', prev.gw).length === 0) {
      out.push({ phase: 'post', gw: prev.gw, deadline: prev.deadline, reason: `${since.toFixed(1)}h after the GW${prev.gw} deadline` });
    }
  }

  const checked = [...all].reverse().find((e) => e.finished && e.dataChecked);
  if (checked && capturesOf(manifest, 'live', checked.gw).length === 0) {
    out.push({ phase: 'live', gw: checked.gw, deadline: checked.deadline, reason: `GW${checked.gw} is finished and data_checked with no live capture` });
  }

  return { captures: out, idle: out.length ? null : notes.join('; ') || 'nothing to capture' };
}

/* --------------------------------------------------------------- fetching */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET one FPL endpoint, retrying 5xx and network errors with backoff (bounded),
 * refusing "the game is being updated" at once (it lasts tens of minutes; the
 * next hourly run is the retry). Returns { url, raw, body, serverDate }.
 */
export async function fetchEndpoint(name, path, {
  fetchImpl = fetch, attempts = 4, baseDelayMs = 2000, sleep = sleepMs, base = FPL_API,
} = {}) {
  const url = base + path;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(baseDelayMs * 2 ** (i - 1));
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    } catch (err) {
      lastErr = new Error(`${name}: network error: ${err.message}`);
      continue;
    }
    const raw = await res.text();
    if (isGameUpdating(raw)) parsePayload(name, raw); // throws, flagged gameUpdating
    if (res.status >= 500) { lastErr = new Error(`${name}: HTTP ${res.status}`); continue; }
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const body = parsePayload(name, raw);
    const date = res.headers && typeof res.headers.get === 'function' ? res.headers.get('date') : null;
    const serverDate = date && Number.isFinite(Date.parse(date)) ? new Date(Date.parse(date)).toISOString() : null;
    return { url, raw, body, serverDate };
  }
  throw lastErr;
}
