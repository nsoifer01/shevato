// The FPL Planner's health probe, run on Netlify's scheduler.
//
// WHY ON NETLIFY (2026-10-10). The probe ran on a GitHub Actions cron, and
// GitHub fires this repository's schedules hours late or not at all (the
// hourly archive cron ran once in eleven slots on 10 October; the daily 06:00
// job starts 5 to 8 hours late every day), so "within a quarter of a day" was
// a hope. Netlify's scheduler has fired on time for both scheduled functions
// this site runs. Its docs promise no exact start time and a 30-second limit,
// so this run is sized for both: two proxy reads, one plan, about four seconds.
//
// WHAT A RUN DOES. The invariants are scripts/lib/probe.mjs, exactly the CLI's
// (scripts/evidence-probe.mjs), read through the production proxy so the
// proxy's own promises are checked too. The result goes to the `fpl-health`
// blob store: `latest` (what fpl-health-status serves), `history` (the last
// HISTORY_LIMIT runs) and `last-reading` (the previous healthy reading, which
// arms the probe's change-detection invariant that a CI runner never had).
//
// ONE RUN PER SLOT. The six-hour slot (00, 06, 12, 18 UTC) is claimed with an
// etag-conditional write before anything is fetched, so a retried or
// duplicated invocation does nothing and costs FPL nothing.
//
// FAILURES DO NOT DISAPPEAR. Netlify has no failure notification below its
// Enterprise plan (log drains are Enterprise-only), so a failure is made
// visible three ways: it is logged as an error; `latest` turns red, and
// fpl-health-status answers 503 (also when no run has landed for
// STALE_AFTER_HOURS, so a scheduler that stops is a failure too, and when a
// run claimed its slot but never recorded a result, so a run killed at the
// 30-second limit is one); and, when FPL_HEALTH_GITHUB_TOKEN is set, the run
// starts .github/workflows/fpl-health.yml at once, which keeps one incident
// issue in step with fpl-health-status and fails, so GitHub emails the owner.
//
// WHY A WORKFLOW AND NOT AN ISSUE (2026-10-10). An issue opened with the
// owner's own token notifies nobody: GitHub never notifies a user about their
// own activity, and the owner's inbox has no mail for anything the
// repository's bots open either (not watching). What reliably reaches them is
// a failed workflow run they triggered, and an @mention from
// github-actions[bot]. So the token can do one thing, start this repository's
// workflows (fine-grained, Actions read/write on this repository only), and
// the issue is written by the workflow with GITHUB_TOKEN, by the same script
// the delayed GitHub schedule runs as the backstop: one writer, one incident.

import { runProbe, payloadShapeFailures } from '../../../apps/fpl-planner/scripts/lib/probe.mjs';
import { FPL_API, USER_AGENT } from '../../../apps/fpl-planner/scripts/lib/archive.mjs';

export const HEALTH_STORE = 'fpl-health';
export const SLOT_HOURS = 6;
export const HISTORY_LIMIT = 120;
export const STALE_AFTER_HOURS = 7;
export const SITE = 'https://shevato.com';
// A run that claimed its slot this long ago and stored nothing is dead:
// Netlify kills a scheduled function at 30 seconds.
export const UNFINISHED_AFTER_MS = 2 * 60e3;
export const ALERT_WORKFLOW = 'fpl-health.yml';
export const ALERT_TIMEOUT_MS = 5000;

export const slotOf = (iso) => {
  const d = new Date(Date.parse(iso));
  const h = Math.floor(d.getUTCHours() / SLOT_HOURS) * SLOT_HOURS;
  return `${d.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}`;
};

/**
 * Claim this slot. `claimed` is false when another invocation already has it;
 * `previous` is the claim this one replaced, so a run can tell whether the
 * one before it ever finished.
 */
async function claimSlot(store, slot, at) {
  const cur = await store.getWithMetadata('slot', { type: 'json' });
  const previous = (cur && cur.data) || null;
  if (previous && previous.slot === slot) return { claimed: false, previous };
  const res = await store.setJSON('slot', { slot, at }, cur && cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  return { claimed: !(res && res.modified === false), previous };
}

async function readPayload(name, fetchImpl, responses) {
  const res = await fetchImpl(`${SITE}/.netlify/functions/fpl?path=${encodeURIComponent(name)}`, {
    headers: { Origin: SITE, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${name}: proxy HTTP ${res.status}`);
  responses[name] = res.headers;
  return res.json();
}

// When the proxy fails, ask FPL directly so the report says WHICH side broke.
async function diagnoseUpstream(fetchImpl) {
  try {
    const res = await fetchImpl(`${FPL_API}bootstrap-static/`, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    return `FPL itself answered ${res.status}`;
  } catch (err) {
    return `FPL itself is unreachable (${err.message})`;
  }
}

const failure = (name, saw, expected) => ({ name, ok: false, saw, expected });

/** One probe of production. Pure apart from `fetchImpl` and the clock. */
export async function probeProduction({ fetchImpl = fetch, now = new Date().toISOString(), prev = null } = {}) {
  const responses = {};
  let bootstrap;
  let fixtures;
  try {
    // In parallel: the two reads are independent, and on Netlify every
    // second counts against the 30-second limit.
    [bootstrap, fixtures] = await Promise.all([
      readPayload('bootstrap-static', fetchImpl, responses),
      readPayload('fixtures', fetchImpl, responses),
    ]);
  } catch (err) {
    return { checks: [failure('the proxy serves the FPL payloads', `${err.message}; ${await diagnoseUpstream(fetchImpl)}`, 'HTTP 200')], reading: null, lines: [] };
  }
  const shape = payloadShapeFailures(bootstrap, fixtures);
  if (shape.length) return { checks: [failure('the payloads have the shape the app reads', shape.join('; '), 'bootstrap and fixtures arrays')], reading: null, lines: [] };
  const result = await runProbe({
    bootstrap, fixtures, fetchedAt: now, now, source: 'proxy', responses, prev,
    // What a first-time visitor's browser fetches (js/data/opening-baseline.js).
    loadShipped: async () => {
      const res = await fetchImpl(`${SITE}/apps/fpl-planner/data/opening-baseline.json`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`opening-baseline.json: HTTP ${res.status}`);
      return res.json();
    },
  });
  return result;
}

/**
 * The scheduled run: claim the slot, probe, store, alert. Returns what was
 * stored (or `{ skipped }`).
 */
export async function runScheduledProbe({ store, fetchImpl = fetch, now = () => new Date().toISOString(), alert = null } = {}) {
  const at = now();
  const slot = slotOf(at);
  const before = await store.get('latest', { type: 'json' });
  const { claimed, previous } = await claimSlot(store, slot, at);
  if (!claimed) return { skipped: `slot ${slot} already probed` };

  const started = Date.now();
  const prev = await store.get('last-reading', { type: 'json' });
  let result;
  try {
    result = await probeProduction({ fetchImpl, now: at, prev });
  } catch (err) {
    result = { checks: [failure('the probe runs to completion', `threw: ${err && err.message}`, 'no exception')], reading: null, lines: [] };
  }
  // The run before this one claimed its slot; if it never stored a result it
  // was killed (the 30-second limit) or crashed, and nothing else would say so.
  const lostSlot = previous && previous.slot && (!before || before.slot !== previous.slot) ? previous.slot : null;
  result.checks.push(lostSlot
    ? failure('the previous scheduled run recorded its result', `slot ${lostSlot} was claimed at ${previous.at || '?'} and stored nothing`, 'a stored result for every claimed slot')
    : { name: 'the previous scheduled run recorded its result', ok: true });
  const failed = result.checks.filter((c) => c.ok === false);
  const latest = {
    at, slot, ok: failed.length === 0, durationMs: Date.now() - started,
    failed: failed.map(({ name, saw, expected }) => ({ name, saw, expected })),
    checks: result.checks.filter((c) => c.ok !== null).map(({ name, ok }) => ({ name, ok })),
    reading: result.reading,
    lines: result.lines,
  };

  await store.setJSON('latest', latest);
  const history = (await store.get('history', { type: 'json' })) || [];
  history.push({ at, slot, ok: latest.ok, failed: latest.failed.map((f) => f.name), durationMs: latest.durationMs });
  await store.setJSON('history', history.slice(-HISTORY_LIMIT));
  if (latest.ok && result.reading) await store.setJSON('last-reading', result.reading);

  // The result is stored BEFORE anything is asked of GitHub, so neither a
  // GitHub outage nor the 30-second limit can lose it; the alert's outcome is
  // then added, where the backstop reads it (an expired token is an incident).
  if (alert) {
    try {
      latest.alert = await alert({ latest, before, nowMs: Date.parse(at) });
    } catch (err) {
      latest.alert = { ok: false, error: String((err && err.message) || err) };
      console.error('fpl-health alert failed', latest.alert.error);
    }
    await store.setJSON('latest', latest);
  }
  return latest;
}

/**
 * What the status endpoint answers: 200 healthy and recent, 503 otherwise.
 * `claim` is the store's slot claim: a claim newer than `latest` that is old
 * enough to have finished is a run that died.
 */
export function statusOf(latest, nowMs = Date.now(), claim = null) {
  if (claim && claim.slot && (!latest || latest.slot !== claim.slot) && nowMs - Date.parse(claim.at) > UNFINISHED_AFTER_MS) {
    return { status: 503, body: { ok: false, reason: `the run for slot ${claim.slot} started at ${claim.at} and never recorded a result (killed at Netlify's 30-second limit, or crashed)`, latest } };
  }
  if (!latest) return { status: 503, body: { ok: false, reason: 'no probe has run yet' } };
  const ageHours = (nowMs - Date.parse(latest.at)) / 3600e3;
  if (ageHours > STALE_AFTER_HOURS) {
    return { status: 503, body: { ok: false, reason: `the last probe ran ${ageHours.toFixed(1)}h ago; the scheduler has missed a slot`, latest } };
  }
  return { status: latest.ok ? 200 : 503, body: { ok: latest.ok, reason: latest.ok ? 'every invariant holds' : `${latest.failed.length} invariant(s) failed`, latest } };
}

/**
 * Immediate alerting, when a token is configured: starts the fpl-health
 * workflow (mode `monitor`), which reconciles the incident issue with
 * fpl-health-status. Started when this run failed and when it may end an
 * incident (the run before failed, is missing, is stale, or could not alert),
 * so a healthy steady state starts nothing. Otherwise it only checks the token
 * can still reach the workflow, so an expired token surfaces while nothing is
 * wrong. Inert (null) without a token.
 */
export function githubDispatchAlert({ token, repo = 'nsoifer01/shevato', ref = 'master', fetchImpl = fetch, timeoutMs = ALERT_TIMEOUT_MS } = {}) {
  if (!token) return null;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${ALERT_WORKFLOW}`;
  const call = (path, init = {}) => fetchImpl(`${url}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shevato-fpl-health',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return async ({ latest, before, nowMs = Date.parse(latest.at) }) => {
    const priorUnsettled = !before || before.ok === false || (before.alert && before.alert.ok === false)
      || nowMs - Date.parse(before.at) > STALE_AFTER_HOURS * 3600e3;
    if (!latest.ok || priorUnsettled) {
      const res = await call('/dispatches', { method: 'POST', body: JSON.stringify({ ref, inputs: { mode: 'monitor' } }) });
      if (res.status !== 204) throw new Error(`workflow dispatch: HTTP ${res.status}`);
      return { ok: true, dispatched: latest.ok ? 'recovery-check' : 'failure' };
    }
    const res = await call('');
    if (!res.ok) throw new Error(`workflow check: HTTP ${res.status}`);
    return { ok: true, dispatched: null };
  };
}
