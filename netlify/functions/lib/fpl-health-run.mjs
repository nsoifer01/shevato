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
import { FPL_API, USER_AGENT, archiveCoverageFailures, seasonLabelFrom } from '../../../apps/fpl-planner/scripts/lib/archive.mjs';
import { stagedManifest } from './fpl-archive-stage.mjs';
import { freeHitPicksInfo } from '../../../apps/fpl-planner/js/engine/squad.js';
import { REFUSAL_KEY } from './fpl-cache.mjs';

export const HEALTH_STORE = 'fpl-health';

// STRONG READS, ALWAYS (2026-10-14). getStore(name) reads through Netlify's
// cached edge, which may serve a value up to 60 seconds old. The recovery
// check is dispatched seconds after `latest` is written, so on 14 October it
// read the failure from six hours before, 12 seconds after the passing result
// was stored, and kept incident #604 open on a healthy site. Every reader of
// this store, and the probe's read of the archive manifest, opens it here.
export const openStrongStore = (getStore, name) => getStore({ name, consistency: 'strong' });
export const SLOT_HOURS = 6;
export const HISTORY_LIMIT = 120;
export const STALE_AFTER_HOURS = 7;
export const SITE = 'https://shevato.com';
// A run that claimed its slot this long ago and stored nothing is dead:
// Netlify kills a scheduled function at 30 seconds.
export const UNFINISHED_AFTER_MS = 2 * 60e3;
// The run's own time, judged before it is stored. 10.3 to 19.0 s over the 25
// runs to 2026-10-16 (the 12:41 UTC slot is the slowest every day): a run past
// this is still stored, and says it is near the kill, rather than the first
// sign being a run that stored nothing.
export const SLOW_RUN_MS = 24e3;
export const ALERT_WORKFLOW = 'fpl-health.yml';
export const ALERT_TIMEOUT_MS = 5000;
// The direct question to FPL below. Bounded so the run, about 15 seconds on
// Netlify, stays inside the 30-second limit when FPL hangs.
export const DIAGNOSE_TIMEOUT_MS = 5000;
// A refusal episode (fpl-cache.mjs REFUSAL_KEY) this long is an incident even
// when it has ended by the time the run looks: on 2026-10-16 FPL refused the
// proxy for up to two hours between two green runs and nothing said so.
export const REFUSAL_ALERT_MINUTES = 30;
// The real manager every run plans, read through the proxy exactly as the app
// reads him (2026-10-16). Every manager-state defect of 2026/27 (free
// transfers, the Free Hit revert, the value check, the alternatives card)
// lived on that path, which the probe's built squad cannot reach. 3855835 is
// the site owner's own public FPL entry; FPL_HEALTH_ENTRY overrides it, and
// "none" turns it off.
export const DEFAULT_HEALTH_ENTRY = '3855835';
export const healthEntryId = (env = globalThis.process ? process.env : {}) => {
  const v = String((env && env.FPL_HEALTH_ENTRY) || DEFAULT_HEALTH_ENTRY).trim();
  return /^\d+$/.test(v) ? v : null;
};

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
// One request, only on a failure, with its status and how long it took: a
// timeout and a fast 503 are different incidents. The body is never read.
async function diagnoseUpstream(fetchImpl) {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${FPL_API}bootstrap-static/`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS),
    });
    let answer = `FPL itself answered ${res.status} in ${Date.now() - started} ms`;
    if (res.ok) {
      if (res.body) await res.body.cancel().catch(() => {});
    } else {
      // Which edge answered and what it said: the difference between a block
      // by address, by rate and an FPL outage.
      const edge = res.headers.get('x-served-by');
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
      answer += `${edge ? `, served by ${edge}` : ''}${body ? `, saying "${body}"` : ''}`;
    }
    return answer;
  } catch (err) {
    return `FPL itself is unreachable after ${Date.now() - started} ms (${err.message})`;
  }
}

const failure = (name, saw, expected) => ({ name, ok: false, saw, expected });

// One manager's payloads, as js/app.js loadTeam reads them: entry, history and
// transfers, the picks of the current gameweek (a 404 before the first
// deadline is pre-season, not an error), and when those picks are a Free Hit
// already played, the squad the chip reverts to. Never throws: a failed read
// comes back as `{ id, error }` and is reported as its own failed check.
export async function readEntry(id, bootstrapReady, fetchImpl, responses = {}) {
  const get = async (path, { optional = false } = {}) => {
    const res = await fetchImpl(`${SITE}/.netlify/functions/fpl?path=${encodeURIComponent(path)}`, {
      headers: { Origin: SITE, Accept: 'application/json' },
    });
    if (optional && res.status === 404) return null;
    if (!res.ok) throw new Error(`${path}: proxy HTTP ${res.status}`);
    responses[path] = res.headers;
    return res.json();
  };
  // Started together with the bootstrap read (the three do not depend on it);
  // only the picks wait for it, to know the current gameweek.
  const base = Promise.all([get(`entry/${id}`), get(`entry/${id}/history`), get(`entry/${id}/transfers`)]);
  base.catch(() => {});
  try {
    const bootstrap = await bootstrapReady;
    const current = (bootstrap.events || []).find((e) => e.is_current);
    const [[entry, history, transfers], picks] = await Promise.all([
      base,
      current ? get(`entry/${id}/event/${current.id}/picks`, { optional: true }) : null,
    ]);
    let revertPicks = null;
    const fh = freeHitPicksInfo({ picks, history });
    const next = (bootstrap.events || []).find((e) => e.is_next);
    if (picks && fh.isFreeHit && fh.event > 1 && next && next.id > fh.event) {
      revertPicks = await get(`entry/${id}/event/${fh.event - 1}/picks`, { optional: true });
    }
    return { id, entry, history, transfers, picks, revertPicks };
  } catch (err) {
    return { id, error: err && err.message ? err.message : String(err) };
  }
}

/** One probe of production. Pure apart from `fetchImpl` and the clock. */
export async function probeProduction({ fetchImpl = fetch, now = new Date().toISOString(), prev = null, entryId = healthEntryId() } = {}) {
  const responses = {};
  let bootstrap;
  let fixtures;
  // In parallel: the reads are independent, and on Netlify every second
  // counts against the 30-second limit.
  const bootstrapRead = readPayload('bootstrap-static', fetchImpl, responses);
  bootstrapRead.catch(() => {});
  const entryRead = entryId ? readEntry(entryId, bootstrapRead, fetchImpl, responses) : null;
  try {
    [bootstrap, fixtures] = await Promise.all([
      bootstrapRead,
      readPayload('fixtures', fetchImpl, responses),
    ]);
  } catch (err) {
    return { checks: [failure('the proxy serves the FPL payloads', `${err.message}; ${await diagnoseUpstream(fetchImpl)}`, 'HTTP 200')], reading: null, lines: [] };
  }
  const shape = payloadShapeFailures(bootstrap, fixtures);
  if (shape.length) return { checks: [failure('the payloads have the shape the app reads', shape.join('; '), 'bootstrap and fixtures arrays')], reading: null, lines: [] };
  const entry = entryRead ? await entryRead : null;
  const result = await runProbe({
    // The real entry's squad state is checked; his plan is the GitHub
    // workflow's (see planEntry in scripts/lib/probe.mjs).
    bootstrap, fixtures, fetchedAt: now, now, source: 'proxy', responses, prev, entry, planEntry: false,
    // What a first-time visitor's browser fetches (js/data/opening-baseline.js).
    loadShipped: async () => {
      const res = await fetchImpl(`${SITE}/apps/fpl-planner/data/opening-baseline.json`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`opening-baseline.json: HTTP ${res.status}`);
      return res.json();
    },
  });
  // A STALE answer means the proxy's own call to FPL just failed, and why is
  // written only to the fpl function's log, which nothing on this plan can
  // read back (the 14 October 06:41 failure stayed unexplained for that
  // reason). So FPL is asked once, now, and the answer joins the failed check
  // and the report. A healthy run asks FPL nothing.
  const stale = Object.keys(responses).filter((name) => responses[name].get('x-fpl-stale') === 'true');
  if (stale.length) {
    const diagnosis = await diagnoseUpstream(fetchImpl);
    for (const c of result.checks) {
      if (c.ok === false && stale.some((name) => c.name === `the proxy serves ${name} fresh and uncached by browsers`)) c.saw = `${c.saw}; ${diagnosis}`;
    }
    result.lines.push('', `upstream        ${diagnosis} (asked directly after the proxy served ${stale.join(' and ')} stale)`);
  }
  // Handed back for the archive check below, which needs the deadlines.
  return { ...result, bootstrap };
}

/**
 * The scheduled run: claim the slot, probe, store, alert. Returns what was
 * stored (or `{ skipped }`).
 */
export async function runScheduledProbe({ store, fetchImpl = fetch, now = () => new Date().toISOString(), alert = null, archiveStore = null, entryId = healthEntryId(), proxyStore = null, slowRunMs = SLOW_RUN_MS } = {}) {
  const at = now();
  const slot = slotOf(at);
  const before = await store.get('latest', { type: 'json' });
  const { claimed, previous } = await claimSlot(store, slot, at);
  if (!claimed) return { skipped: `slot ${slot} already probed` };

  const started = Date.now();
  const prev = await store.get('last-reading', { type: 'json' });
  let result;
  try {
    result = await probeProduction({ fetchImpl, now: at, prev, entryId });
  } catch (err) {
    result = { checks: [failure('the probe runs to completion', `threw: ${err && err.message}`, 'no exception')], reading: null, lines: [] };
  }
  // The run before this one claimed its slot; if it never stored a result it
  // was killed (the 30-second limit) or crashed, and nothing else would say so.
  const lostSlot = previous && previous.slot && (!before || before.slot !== previous.slot) ? previous.slot : null;
  result.checks.push(lostSlot
    ? failure('the previous scheduled run recorded its result', `slot ${lostSlot} was claimed at ${previous.at || '?'} and stored nothing`, 'a stored result for every claimed slot')
    : { name: 'the previous scheduled run recorded its result', ok: true });
  // The deadline archive (fpl-archive-capture) runs hourly on Netlify, where a
  // failing scheduled function tells nobody, and a deadline it misses is lost
  // for good. This run alerts, so it checks the staged captures are keeping up.
  if (archiveStore && result.bootstrap) {
    const name = 'the deadline archive holds the captures due by now';
    try {
      const manifest = await stagedManifest(archiveStore, seasonLabelFrom(result.bootstrap));
      const missing = archiveCoverageFailures({ bootstrap: result.bootstrap, manifest, now: at });
      result.checks.push(missing.length
        ? failure(name, missing.join('; '), 'a staged capture for every deadline phase that is due')
        : { name, ok: true });
    } catch (err) {
      result.checks.push(failure(name, `could not read the staged archive: ${err && err.message}`, 'a readable fpl-archive manifest'));
    }
  }
  if (proxyStore) {
    const name = 'FPL has not refused the proxy for long since the last run';
    try {
      const refusal = await proxyStore.get(REFUSAL_KEY, { type: 'json' });
      const check = refusalCheck(refusal, before && before.at, at);
      result.checks.push(check.ok ? { name, ok: true } : failure(name, check.saw, `no refusal episode of ${REFUSAL_ALERT_MINUTES} minutes or more`));
      if (check.line) result.lines.push('', check.line);
    } catch (err) {
      result.checks.push(failure(name, `could not read the proxy's refusal record: ${err && err.message}`, 'a readable fpl-planner store'));
    }
  }
  const elapsed = Date.now() - started;
  const slowName = 'the run finishes well inside Netlify\'s 30-second limit';
  result.checks.push(elapsed > slowRunMs
    ? failure(slowName, `${(elapsed / 1000).toFixed(1)} s`, `under ${slowRunMs / 1000} s`)
    : { name: slowName, ok: true });
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
 * The proxy's last refusal by FPL, judged: anything since the previous run
 * is reported as a line, and an episode of REFUSAL_ALERT_MINUTES or more (or
 * one still in its backoff now and started that long ago) fails the run.
 */
export function refusalCheck(refusal, previousAt, at) {
  if (!refusal || typeof refusal.at !== 'string') return { ok: true, line: null };
  const nowMs = Date.parse(at);
  const since = Date.parse(previousAt);
  if (Number.isFinite(since) && Date.parse(refusal.at) <= since) return { ok: true, line: null };
  const first = Date.parse(refusal.firstAt) || Date.parse(refusal.at);
  const active = Date.parse(refusal.until) > nowMs;
  const end = active ? nowMs : Date.parse(refusal.at);
  const minutes = Math.round((end - first) / 60e3);
  const edge = refusal.headers && refusal.headers['x-served-by'];
  const saw = `FPL answered ${refusal.status} to ${refusal.count || 1} proxy fetch(es) from ${new Date(first).toISOString()} to ${refusal.at}`
    + ` (${minutes} min${active ? ', still backing off' : ''}; last ${refusal.path}${edge ? `, served by ${edge}` : ''}`
    + `${refusal.bodyHead ? `, saying "${refusal.bodyHead.slice(0, 160)}"` : ''})`;
  return { ok: minutes < REFUSAL_ALERT_MINUTES, saw, line: `refused        ${saw}` };
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
      // expect_at names this run, so the monitor waits until the status shows
      // it (or something newer) instead of judging the result before it.
      const res = await call('/dispatches', { method: 'POST', body: JSON.stringify({ ref, inputs: { mode: 'monitor', expect_at: latest.at } }) });
      if (res.status !== 204) throw new Error(`workflow dispatch: HTTP ${res.status}`);
      return { ok: true, dispatched: latest.ok ? 'recovery-check' : 'failure' };
    }
    const res = await call('');
    if (!res.ok) throw new Error(`workflow check: HTTP ${res.status}`);
    return { ok: true, dispatched: null };
  };
}
