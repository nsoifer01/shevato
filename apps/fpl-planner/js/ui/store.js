// Persistence for the planner.
//
// Four keys, all inside the `fplPlannerApp` sync namespace registered in
// sync-system/app-sync-init.js, so a signed-in user gets them on every device
// and a signed-out user still gets everything from localStorage. Bulk FPL data
// (bootstrap, fixtures) is deliberately NOT here: it lives under the unsynced
// `fpl-planner:cache:` prefix owned by js/data/api.js, because it is large,
// public and identical for every user.
//
// The pure helpers (validateTeamId, recordPlanVersion, compactPlan) carry the
// rules and are unit tested; the read/write wrappers are the only part that
// touches localStorage.

export const KEYS = {
  teamId: 'fplPlannerTeamId',
  settings: 'fplPlannerSettings',
  planHistory: 'fplPlannerPlanHistory',
  squadSnapshot: 'fplPlannerSquadSnapshot',
};

export const SYNC_NAMESPACE = 'fplPlannerApp';

// The horizons Settings offers. Exported so the default below can be checked
// against them: a default that is not in this list renders a select with
// nothing selected, and the browser then silently substitutes the first option,
// which would override the measured default without anything failing.
export const HORIZON_CHOICES = [3, 5, 8];

// horizon 5 matches planner.js DEFAULT_HORIZON, where the measurement that
// chose it is written down. A test asserts this number equals the engine's
// rather than checking it against a literal.
export const DEFAULT_SETTINGS = { horizon: 5, risk: 'balanced', lastView: 'plan' };

// Plan history is synced, so it has to stay small. Five versions of the
// current gameweek is enough to see how a plan moved during the week, and
// eight gameweeks is enough to look back over a chip cycle.
export const MAX_VERSIONS_PER_GW = 5;
export const MAX_GWS_KEPT = 8;

// FPL entry ids are positive integers handed out in registration order. The
// upper bound is a sanity guard, not a rule from the API: total_players was
// 10,755,001 on 2026-09-13, about half of it, so anything above is a typo. Ids
// outrun total_players, so the bound needs raising before a season's
// registrations come near it.
export const MAX_TEAM_ID = 20000000;

export function validateTeamId(raw) {
  const value = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!value) return { ok: false, message: 'Enter your FPL Team ID to continue.' };
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: 'A Team ID is digits only, with no letters, spaces or punctuation.' };
  }
  const n = Number(value);
  if (n <= 0) return { ok: false, message: 'Team IDs start at 1.' };
  if (n > MAX_TEAM_ID) return { ok: false, message: 'That number is larger than any Fantasy Premier League team ID.' };
  return { ok: true, teamId: String(n) };
}

// What is worth keeping per stored plan version. The full Plan carries the
// alternatives and the whole explanation tree; history only has to answer
// "what did it tell me, and what did it expect".
export function compactPlan(plan) {
  if (!plan) return null;
  return {
    gw: plan.gw,
    chip: plan.chip || null,
    transfersOut: (plan.transfersOut || []).slice(),
    transfersIn: (plan.transfersIn || []).slice(),
    transferCount: plan.transferCount || 0,
    hits: plan.hits || 0,
    hitCostPoints: plan.hitCostPoints || 0,
    captain: plan.captain,
    viceCaptain: plan.viceCaptain,
    formation: plan.formation,
    xPointsGw: plan.xPointsGw,
    xPointsNet: plan.xPointsNet,
    xPointsHorizon: plan.xPointsHorizon,
    bankAfterTenths: plan.bankAfterTenths,
    headline: (plan.explanation && plan.explanation.headline) || null,
    modelVersion: plan.modelVersion || null,
    durationMs: plan.durationMs || null,
  };
}

// Append a version for a gameweek, then cap. Versions number from 1 and never
// restart, so "v3" always means the third plan calculated for that gameweek
// even after older versions have been dropped.
//
// `inputs` is the snapshot js/ui/plan-diff.js builds: the prices, statuses and
// projections the plan was built from. It is stored because the next version
// cannot otherwise say WHICH field moved, only that something did. Its shape is
// owned by plan-diff.js; this function only carries it.
export function recordPlanVersion(history, gw, { plan, reason, computedAt, fingerprint, inputs = null }) {
  const next = { ...(history || {}) };
  const key = String(gw);
  const list = Array.isArray(next[key]) ? next[key].slice() : [];
  const version = list.length ? list[list.length - 1].version + 1 : 1;

  list.push({
    version,
    computedAt: computedAt || new Date().toISOString(),
    reason: reason || 'first-calculation',
    fingerprint: fingerprint || null,
    plan: compactPlan(plan),
    inputs,
  });

  next[key] = list.slice(-MAX_VERSIONS_PER_GW);

  const gws = Object.keys(next).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  for (const old of gws.slice(0, Math.max(0, gws.length - MAX_GWS_KEPT))) delete next[String(old)];
  return next;
}

export function latestVersion(history, gw) {
  const list = history && history[String(gw)];
  if (!Array.isArray(list) || !list.length) return null;
  return list[list.length - 1];
}

// PLAN HISTORY IS PER TEAM AND SEASON (2026-10-25). The key used to hold one
// map of gameweek -> versions for whoever was planned last, so opening a
// second team in the same browser compared it with the first team's plan
// ("Plan updated: previously Calvert-Lewin out", on a team that never owned
// that player), its History tab listed the other team's plans, and a fresh squad read
// as "your squad changed". Found verifying #628 in production. Now the stored
// value is
//   { v: 2, scopes: { "<teamId>|<season>": { teamId, season, touchedAt, gws } } }
// where `gws` is the old per-gameweek map with the old limits, and the readers
// below hand callers ONE scope's map, so nothing downstream changed shape.
// It is still one synced key (sync-system/app-sync-init.js lists keys, not a
// prefix), so the number of scopes is capped: the MAX_HISTORY_SCOPES most
// recently written survive, which bounds the synced size at that many times
// the old one.
//
// History written before this had no team or season, and nothing in it says
// whose it was (the bug itself mixed teams in it), so it is never attributed:
// it is not read, and the first scoped write replaces it. A value another
// device wrote in the old shape is treated the same way. A season that cannot
// be read from the payload gives no scope, so no history is read or written
// rather than seasons being mixed.
export const PLAN_HISTORY_SHAPE = 2;
export const MAX_HISTORY_SCOPES = 3;

/** The scope a plan belongs to, or null when the team or the season is unknown. */
export function planHistoryScope(teamId, season) {
  const team = validateTeamId(teamId);
  if (!team.ok || typeof season !== 'string' || !season.trim()) return null;
  return { teamId: team.teamId, season: season.trim(), key: `${team.teamId}|${season.trim()}` };
}

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// One scope's per-gameweek map, kept only where it has the shape the views
// read: integer gameweek keys, arrays of versions with a positive integer
// `version` and a plan object, within the per-gameweek and per-scope limits.
function sanitizeGws(gws) {
  const out = {};
  if (!isRecord(gws)) return out;
  const keys = Object.keys(gws).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b).slice(-MAX_GWS_KEPT);
  for (const gw of keys) {
    const list = Array.isArray(gws[String(gw)]) ? gws[String(gw)] : [];
    const kept = list.filter(r => isRecord(r) && Number.isInteger(r.version) && r.version > 0 && isRecord(r.plan));
    if (kept.length) out[String(gw)] = kept.slice(-MAX_VERSIONS_PER_GW);
  }
  return out;
}

/** Every scope in a stored value, sanitized; a value in any other shape holds none. */
export function readPlanHistories(raw) {
  const scopes = {};
  if (isRecord(raw) && raw.v === PLAN_HISTORY_SHAPE && isRecord(raw.scopes)) {
    for (const [key, bucket] of Object.entries(raw.scopes)) {
      if (!isRecord(bucket)) continue;
      const scope = planHistoryScope(bucket.teamId, bucket.season);
      if (!scope || scope.key !== key) continue;
      const gws = sanitizeGws(bucket.gws);
      if (!Object.keys(gws).length) continue;
      scopes[key] = { teamId: scope.teamId, season: scope.season, touchedAt: typeof bucket.touchedAt === 'string' ? bucket.touchedAt : '', gws };
    }
  }
  return { v: PLAN_HISTORY_SHAPE, scopes };
}

/** One scope's gameweek -> versions map (empty for no scope or no history). */
export function historyForScope(histories, scope) {
  if (!scope) return {};
  const bucket = histories && histories.scopes && histories.scopes[scope.key];
  return bucket ? bucket.gws : {};
}

/** `histories` with a version appended to one scope, then every limit applied. */
export function recordScopedPlanVersion(histories, scope, gw, entry) {
  const base = readPlanHistories(histories);
  if (!scope) return base;
  const prior = base.scopes[scope.key];
  const gws = recordPlanVersion(prior ? prior.gws : {}, gw, entry);
  const touchedAt = (entry && entry.computedAt) || new Date().toISOString();
  const scopes = { ...base.scopes, [scope.key]: { teamId: scope.teamId, season: scope.season, touchedAt, gws } };
  const keep = Object.keys(scopes)
    .sort((a, b) => (a === scope.key ? -1 : b === scope.key ? 1 : String(scopes[b].touchedAt).localeCompare(String(scopes[a].touchedAt))))
    .slice(0, MAX_HISTORY_SCOPES);
  return { v: PLAN_HISTORY_SHAPE, scopes: Object.fromEntries(keep.map(k => [k, scopes[k]])) };
}

/**
 * The version the plan just computed is compared with: the one remembered in
 * this session when it belongs to the same scope, else the latest stored for
 * that scope and gameweek. `memory` is `{ key, record }`; `memoryKey` is the
 * scope key now (sample mode uses its own, and stores nothing).
 */
export function comparableVersion({ memory, memoryKey, history, gw }) {
  if (memory && memory.key === memoryKey && memory.record) return memory.record;
  return latestVersion(history, gw);
}

/* ------------------------------------------------------------- localStorage */

function ls() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readJson(key, fallback) {
  const store = ls();
  if (!store) return fallback;
  const raw = store.getItem(key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null ? fallback : parsed;
  } catch {
    // A corrupted value is not worth a crash on boot: drop it and carry on
    // with the default.
    store.removeItem(key);
    return fallback;
  }
}

function writeJson(key, value) {
  const store = ls();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* quota. The session still works from memory. */
  }
}

export function getTeamId() {
  const store = ls();
  if (!store) return null;
  const raw = store.getItem(KEYS.teamId);
  if (!raw) return null;
  // Older writes could have JSON-quoted the value; accept both shapes.
  const value = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  const check = validateTeamId(value);
  return check.ok ? check.teamId : null;
}

export function setTeamId(teamId) {
  const store = ls();
  if (store) store.setItem(KEYS.teamId, String(teamId));
}

export const RISK_CHOICES = ['balanced', 'aggressive', 'conservative'];
export const VIEW_CHOICES = ['plan', 'history', 'settings'];

// Settings arrive from localStorage, which another device or an older version
// can have written with the wrong types (`{"horizon":"x","risk":42}` reached
// the planner and produced the generic load-failure screen). Each field is
// checked against its closed set and silently falls back to the default.
export function sanitizeSettings(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const horizon = Number(input.horizon);
  return {
    horizon: HORIZON_CHOICES.includes(horizon) ? horizon : DEFAULT_SETTINGS.horizon,
    risk: RISK_CHOICES.includes(input.risk) ? input.risk : DEFAULT_SETTINGS.risk,
    lastView: VIEW_CHOICES.includes(input.lastView) ? input.lastView : DEFAULT_SETTINGS.lastView,
  };
}

export function getSettings() {
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...readJson(KEYS.settings, {}) });
}

export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson(KEYS.settings, next);
  return next;
}

/** One scope's stored plan history (see "PLAN HISTORY IS PER TEAM AND SEASON"). */
export function getPlanHistory(scope) {
  return historyForScope(readPlanHistories(readJson(KEYS.planHistory, null)), scope);
}

/** Append a version to one scope's stored history; no scope writes nothing. */
export function recordPlanHistory(scope, gw, entry) {
  if (!scope) return;
  writeJson(KEYS.planHistory, recordScopedPlanVersion(readJson(KEYS.planHistory, null), scope, gw, entry));
}

// The squad the user built or typed, in a shape that can be READ BACK.
//
// This key was written on every plan and never read, so a manager who typed
// fifteen players pre-season lost them on reload, during the one week when
// typing them in is the only thing the app can do. It is deliberately small
// (ids and the context needed to know they still apply) because it syncs to the
// account, and it stores ids rather than a serialized SquadState because JSON
// turns the pre-season `Infinity` free-transfer count into null.
export function getSquadSnapshot() {
  return readJson(KEYS.squadSnapshot, null);
}

export function setSquadSnapshot(snapshot) {
  writeJson(KEYS.squadSnapshot, snapshot);
}

// Is this snapshot about the squad we are looking at now? A snapshot from
// another team, another season or another gameweek describes something else and
// restoring it would silently put a stranger's fifteen on screen.
export function snapshotApplies(snapshot, { teamId, season, gw }) {
  if (!snapshot || !Array.isArray(snapshot.ids) || !snapshot.ids.length) return false;
  if (String(snapshot.teamId ?? '') !== String(teamId ?? '')) return false;
  if (snapshot.season && season && snapshot.season !== season) return false;
  if (Number.isFinite(snapshot.gw) && Number.isFinite(gw) && snapshot.gw !== gw) return false;
  return true;
}

// Removing through localStorage.removeItem is what propagates the deletion to
// the cloud: sync-system overrides removeItem and writes a tombstone, so a
// second device drops the key on its next sync instead of resurrecting it.
export function removeKeys(keys) {
  const store = ls();
  if (!store) return;
  for (const k of keys) store.removeItem(k);
}

export function disconnectTeamKeys() {
  return [KEYS.teamId, KEYS.squadSnapshot];
}

export function allKeys() {
  return [KEYS.teamId, KEYS.settings, KEYS.planHistory, KEYS.squadSnapshot];
}

// The data layer's cache keys that hold THIS MANAGER's data: the entry, its
// history, its transfers and its picks, under a key that contains the team id.
// They are not synced, so they are not in the lists above, but "disconnect"
// and "delete everything" both have to take them too (2026-08-22 audit: the
// squad, bank and history survived both buttons).
export const ENTRY_CACHE_PREFIX = 'fpl-planner:cache:entry/';

export function entryCacheKeys() {
  const store = ls();
  if (!store) return [];
  const keys = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(ENTRY_CACHE_PREFIX)) keys.push(k);
  }
  return keys;
}
