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
// upper bound is a sanity guard, not a rule from the API: total_players has
// never been within an order of magnitude of it, so anything above is a typo.
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

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(KEYS.settings, {}) };
}

export function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson(KEYS.settings, next);
  return next;
}

export function getPlanHistory() {
  return readJson(KEYS.planHistory, {});
}

export function setPlanHistory(history) {
  writeJson(KEYS.planHistory, history);
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
