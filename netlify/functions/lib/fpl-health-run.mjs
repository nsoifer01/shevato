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
// STALE_AFTER_HOURS, so a scheduler that stops is a failure too); and, when
// FPL_HEALTH_GITHUB_TOKEN is set, a GitHub issue is opened at once (GitHub
// emails the repository's watchers) and closed again on recovery.

import { runProbe, payloadShapeFailures } from '../../../apps/fpl-planner/scripts/lib/probe.mjs';
import { FPL_API, USER_AGENT } from '../../../apps/fpl-planner/scripts/lib/archive.mjs';

export const HEALTH_STORE = 'fpl-health';
export const SLOT_HOURS = 6;
export const HISTORY_LIMIT = 120;
export const STALE_AFTER_HOURS = 7;
export const SITE = 'https://shevato.com';
export const ISSUE_MARKER = '[fpl-health]';

export const slotOf = (iso) => {
  const d = new Date(Date.parse(iso));
  const h = Math.floor(d.getUTCHours() / SLOT_HOURS) * SLOT_HOURS;
  return `${d.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}`;
};

/** Claim this slot. False when another invocation already has it. */
async function claimSlot(store, slot) {
  const cur = await store.getWithMetadata('slot', { type: 'json' });
  if (cur && cur.data && cur.data.slot === slot) return false;
  const res = await store.setJSON('slot', { slot }, cur && cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
  return !(res && res.modified === false);
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
    bootstrap = await readPayload('bootstrap-static', fetchImpl, responses);
    fixtures = await readPayload('fixtures', fetchImpl, responses);
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
  if (!(await claimSlot(store, slot))) return { skipped: `slot ${slot} already probed` };

  const started = Date.now();
  const prev = await store.get('last-reading', { type: 'json' });
  let result;
  try {
    result = await probeProduction({ fetchImpl, now: at, prev });
  } catch (err) {
    result = { checks: [failure('the probe runs to completion', `threw: ${err && err.message}`, 'no exception')], reading: null, lines: [] };
  }
  const failed = result.checks.filter((c) => c.ok === false);
  const latest = {
    at, slot, ok: failed.length === 0, durationMs: Date.now() - started,
    failed: failed.map(({ name, saw, expected }) => ({ name, saw, expected })),
    checks: result.checks.filter((c) => c.ok !== null).map(({ name, ok }) => ({ name, ok })),
    reading: result.reading,
    lines: result.lines,
  };

  const before = await store.get('latest', { type: 'json' });
  await store.setJSON('latest', latest);
  const history = (await store.get('history', { type: 'json' })) || [];
  history.push({ at, slot, ok: latest.ok, failed: latest.failed.map((f) => f.name), durationMs: latest.durationMs });
  await store.setJSON('history', history.slice(-HISTORY_LIMIT));
  if (latest.ok && result.reading) await store.setJSON('last-reading', result.reading);

  if (alert) {
    try {
      await alert({ latest, before });
    } catch (err) {
      console.error('fpl-health alert failed', String(err && err.message));
    }
  }
  return latest;
}

/** What the status endpoint answers: 200 healthy and recent, 503 otherwise. */
export function statusOf(latest, nowMs = Date.now()) {
  if (!latest) return { status: 503, body: { ok: false, reason: 'no probe has run yet' } };
  const ageHours = (nowMs - Date.parse(latest.at)) / 3600e3;
  if (ageHours > STALE_AFTER_HOURS) {
    return { status: 503, body: { ok: false, reason: `the last probe ran ${ageHours.toFixed(1)}h ago; the scheduler has missed a slot`, latest } };
  }
  return { status: latest.ok ? 200 : 503, body: { ok: latest.ok, reason: latest.ok ? 'every invariant holds' : `${latest.failed.length} invariant(s) failed`, latest } };
}

/**
 * Immediate alerting through GitHub issues, when a token is configured:
 * opens one issue on the first failed run, comments while it stays red,
 * closes it on recovery. Inert without a token.
 */
export function githubIssueAlert({ token, repo = 'nsoifer01/shevato', fetchImpl = fetch } = {}) {
  if (!token) return null;
  const api = (path, init = {}) => fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shevato-fpl-health',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const describe = (latest) => [
    `Probe at ${latest.at} (slot ${latest.slot}).`, '',
    ...latest.failed.map((f) => `- **${f.name}**: saw ${f.saw}, expected ${f.expected}`), '',
    `Status: ${SITE}/.netlify/functions/fpl-health-status`,
  ].join('\n');
  return async ({ latest }) => {
    const res = await api('/issues?state=open&per_page=100');
    if (!res.ok) throw new Error(`GitHub issues list: HTTP ${res.status}`);
    const open = (await res.json()).find((i) => !i.pull_request && String(i.title).startsWith(ISSUE_MARKER));
    if (!latest.ok) {
      if (open) return api(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Still failing.\n\n${describe(latest)}` }) });
      return api('/issues', { method: 'POST', body: JSON.stringify({ title: `${ISSUE_MARKER} FPL Planner health probe failed: ${latest.failed.map((f) => f.name).join('; ')}`.slice(0, 250), body: describe(latest) }) });
    }
    if (open) {
      await api(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `Recovered at ${latest.at}: every invariant holds.` }) });
      return api(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
    }
    return null;
  };
}
