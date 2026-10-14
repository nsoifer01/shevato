#!/usr/bin/env node
// The FPL Planner health probe's incident keeper, run by
// .github/workflows/fpl-health.yml with the workflow's own GITHUB_TOKEN.
//
// It reads the Netlify probe's status endpoint, judges it independently, and
// keeps exactly one `[fpl-health]` issue in step with it: opened (with an
// @mention of the owner, which is what reaches their inbox) when something is
// wrong, left alone while the same thing stays wrong, commented when what is
// wrong changes, and closed when everything is right again. It exits 1 while
// anything is wrong, so the run is red and GitHub emails the owner too.
//
// Two things start it, and both run THIS script, so there is one writer and
// one incident, never two contradicting alerts:
//   - the Netlify probe, at once, on a failure or a possible recovery
//     (workflow_dispatch, mode `monitor`; netlify/functions/lib/fpl-health-run.mjs);
//   - GitHub's own schedule, the late but independent backstop that still
//     fires when Netlify has stopped running anything.
//
// It never trusts the endpoint's verdict alone: a result older than
// STALE_AFTER_HOURS is stale by THIS clock, so a backstop that runs hours
// late, or an endpoint answering 200 from an old result, cannot read as
// healthy.
//
//   node apps/fpl-planner/scripts/health-monitor.mjs             # the real thing
//   node apps/fpl-planner/scripts/health-monitor.mjs --drill failure|recovery
//
// A drill judges a synthetic status instead of the real one and keeps its own
// `[fpl-health drill]` issue, so it exercises the whole path (issue, mention,
// red run, close) without touching a real incident.
//
// A run the Netlify probe dispatched knows which probe started it
// (FPL_HEALTH_EXPECT_AT, the workflow's `expect_at` input): it waits until the
// endpoint shows that run or a newer one, and never judges the result BEFORE
// it. On 14 October a recovery check read the six-hour-old failure 12 seconds
// after the pass was stored (an eventually consistent read, now strong) and
// kept the incident open; if the endpoint ever lags like that again, the run
// says so, red, rather than repeating an old verdict either way.
//
// Environment: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), optionally
// GITHUB_SERVER_URL + GITHUB_RUN_ID (to link the run), FPL_HEALTH_MENTION
// (default: the repository owner), FPL_HEALTH_STATUS_URL, FPL_HEALTH_EXPECT_AT.

import { pathToFileURL } from 'node:url';

export const STATUS_URL = 'https://shevato.com/.netlify/functions/fpl-health-status';
export const STALE_AFTER_HOURS = 7;
// How long a dispatched run waits for the endpoint to show the probe that
// started it: past Netlify Blobs' documented 60-second drift, with room.
export const EXPECT_WAIT_MS = 90e3;
export const EXPECT_POLL_MS = 10e3;
export const MARKER = '[fpl-health]';
export const DRILL_MARKER = '[fpl-health drill]';
const FINGERPRINT_RE = /<!-- fpl-health:([^>]*?) -->/g;

/**
 * Everything wrong with one reading of the status endpoint, by THIS clock.
 * `http` is the status code (or null when the request failed), `body` the
 * parsed JSON (or null), `error` the request's failure.
 */
export function assess({ http, body, error = null, nowMs = Date.now(), expectAt = null }) {
  const problems = [];
  const add = (key, text, short) => problems.push({ key, text, short });
  if (http == null || !body || typeof body !== 'object') {
    add('endpoint', `fpl-health-status could not be read (${error || (http == null ? 'no response' : `HTTP ${http}, not JSON`)}); Netlify or the function is down`, 'status endpoint unreachable');
    return { problems, latest: null };
  }
  const latest = body.latest || null;
  if (!latest || !latest.at) {
    add('no-run', `no probe result: ${body.reason || 'the status carries no latest run'}`, 'no probe result');
    return { problems, latest };
  }
  // Behind the probe that started this run: what it shows is no longer the
  // state of production, so neither its failures nor its passes are judged.
  // Red, so an incident stays open and nothing reads as recovered.
  if (isBehind(latest, expectAt)) {
    add('status-behind', `fpl-health-status still shows the probe at ${latest.at}, not the one at ${expectAt} that started this check; the status store is serving an old result`, 'status endpoint shows an old result');
    return { problems, latest };
  }
  const ageHours = (nowMs - Date.parse(latest.at)) / 3600e3;
  if (!(ageHours <= STALE_AFTER_HOURS)) {
    add('stale', `the last probe ran ${Number.isFinite(ageHours) ? ageHours.toFixed(1) : '?'}h ago (at ${latest.at}); Netlify has stopped running the scheduled function`, 'probe result is stale');
  }
  for (const f of latest.failed || []) add(`check:${f.name}`, `${f.name}: saw ${f.saw}, expected ${f.expected}`, f.name);
  if (latest.alert && latest.alert.ok === false) {
    add('alert-channel', `the Netlify probe could not reach GitHub to alert at once (${latest.alert.error}); check FPL_HEALTH_GITHUB_TOKEN (expired or revoked?)`, 'immediate alerting is broken');
  }
  // The endpoint's own judgement, for what only it can see (a run that
  // claimed its slot and never stored anything). Never the other way round:
  // a 200 does not cancel a problem found above.
  if (http !== 200 && !problems.length) add('endpoint-unhealthy', `fpl-health-status answered ${http}: ${body.reason || 'no reason given'}`, 'status endpoint unhealthy');
  return { problems, latest };
}

/** A usable ISO time from the workflow input, else null (absent or junk is ignored). */
export function parseExpectAt(raw) {
  const ms = Date.parse(raw || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const isBehind = (latest, expectAt) => Boolean(expectAt && latest && latest.at && Date.parse(latest.at) < Date.parse(expectAt));

// WHAT is wrong, not when: the same failure on the next slot is the same
// incident and posts nothing (the red run still emails); a different set of
// problems posts one comment.
const fingerprintOf = (problems) => problems.map((p) => p.key).sort().join('|');

function describe({ problems, latest, statusUrl, runUrl, nowIso }) {
  const lines = [
    `Checked at ${nowIso} by the fpl-health workflow${runUrl ? ` ([run](${runUrl}))` : ''}.`,
    '',
    ...problems.map((p) => `- ${p.text}`),
    '',
  ];
  if (latest && latest.at) {
    lines.push(`Last probe: ${latest.at} (slot ${latest.slot}), ${latest.ok ? 'passed' : 'FAILED'}, ${latest.durationMs} ms, ${(latest.checks || []).length} checks.`);
    if (Array.isArray(latest.lines) && latest.lines.length) {
      lines.push('', '<details><summary>Probe report</summary>', '', '```', ...latest.lines, '```', '', '</details>');
    }
  }
  lines.push('', `Status: ${statusUrl}`);
  return lines.join('\n');
}

/**
 * Bring the issue in line with `problems`. `api(path, init)` is a fetch bound
 * to the repository's REST root. Returns what it did.
 */
export async function reconcile({ problems, latest, api, marker = MARKER, mention = null, statusUrl = STATUS_URL, runUrl = null, nowIso = new Date().toISOString() }) {
  const json = async (res, what) => {
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  const issues = await json(await api('/issues?state=open&per_page=100'), 'list issues');
  const open = issues.find((i) => !i.pull_request && typeof i.title === 'string' && i.title.startsWith(`${marker} `));
  const fp = fingerprintOf(problems);
  const stamp = `<!-- fpl-health:${fp} -->`;
  const body = (head) => `${head}\n\n${describe({ problems, latest, statusUrl, runUrl, nowIso })}\n\n${stamp}`;

  if (problems.length && !open) {
    const title = `${marker} ${problems.map((p) => p.short).join('; ')}`.slice(0, 240);
    const created = await json(await api('/issues', { method: 'POST', body: JSON.stringify({ title, body: body(`${mention ? `@${mention} ` : ''}The FPL Planner health probe is failing.`) }) }), 'open issue');
    return { action: 'opened', issue: created && created.number, fingerprint: fp };
  }
  if (!open) return { action: 'healthy', fingerprint: fp };

  // The fingerprint the issue last recorded: the newest comment carrying one,
  // else the issue body's.
  const comments = await json(await api(`/issues/${open.number}/comments?per_page=100`), 'list comments');
  let last = null;
  for (const text of [open.body || '', ...comments.map((c) => c.body || '')]) {
    for (const m of text.matchAll(FINGERPRINT_RE)) last = m[1];
  }
  if (problems.length) {
    if (last === fp) return { action: 'unchanged', issue: open.number, fingerprint: fp };
    await json(await api(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: body(`${mention ? `@${mention} ` : ''}Still failing, and what is wrong has changed.`) }) }), 'comment');
    return { action: 'commented', issue: open.number, fingerprint: fp };
  }
  await json(await api(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: body('Recovered: every invariant holds and the result is fresh.') }) }), 'comment');
  await json(await api(`/issues/${open.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) }), 'close issue');
  return { action: 'closed', issue: open.number, fingerprint: fp };
}

/** A synthetic status for a drill: a failed probe, or a healthy one. */
export function drillStatus(kind, nowIso) {
  const base = { at: nowIso, slot: 'drill', durationMs: 0, checks: [{ name: 'drill check', ok: kind !== 'failure' }], lines: ['(drill: a synthetic result, not a probe)'] };
  if (kind === 'failure') {
    return { http: 503, body: { ok: false, reason: '1 invariant(s) failed', latest: { ...base, ok: false, failed: [{ name: 'drill check', saw: 'a simulated failure', expected: 'a pass' }] } } };
  }
  if (kind === 'recovery') return { http: 200, body: { ok: true, reason: 'every invariant holds', latest: { ...base, ok: true, failed: [] } } };
  throw new Error(`--drill takes failure or recovery, not ${kind}`);
}

async function readOnce(url, fetchImpl, sleep) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30e3) });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (body) return { http: res.status, body };
      last = { http: res.status, body: null };
    } catch (err) {
      last = { http: null, body: null, error: String((err && err.message) || err) };
    }
    await sleep(5000);
  }
  return last;
}

/**
 * Read the status endpoint. With `expectAt`, re-read every EXPECT_POLL_MS
 * while it still shows an older run, for up to EXPECT_WAIT_MS; what it shows
 * then is judged by assess() (behind is a problem of its own).
 */
export async function readStatus(url, fetchImpl, { expectAt = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), waitMs = EXPECT_WAIT_MS, pollMs = EXPECT_POLL_MS } = {}) {
  let reading = await readOnce(url, fetchImpl, sleep);
  for (let waited = 0; waited < waitMs && reading.body && isBehind(reading.body.latest, expectAt); waited += pollMs) {
    await sleep(pollMs);
    reading = await readOnce(url, fetchImpl, sleep);
  }
  return reading;
}

async function main(argv) {
  const i = argv.indexOf('--drill');
  const drill = i >= 0 ? argv[i + 1] : null;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  const nowIso = new Date().toISOString();
  const statusUrl = process.env.FPL_HEALTH_STATUS_URL || STATUS_URL;
  const expectAt = drill ? null : parseExpectAt(process.env.FPL_HEALTH_EXPECT_AT);
  const reading = drill ? drillStatus(drill, nowIso) : await readStatus(statusUrl, fetch, { expectAt });
  // The clock is read after the wait, so staleness is judged as of now.
  const judgedAt = drill ? nowIso : new Date().toISOString();
  const { problems, latest } = assess({ ...reading, nowMs: Date.parse(judgedAt), expectAt });
  const api = (path, init = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shevato-fpl-health',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const mention = process.env.FPL_HEALTH_MENTION || repo.split('/')[0];
  const result = await reconcile({ problems, latest, api, marker: drill ? DRILL_MARKER : MARKER, mention, statusUrl, runUrl, nowIso: judgedAt });

  console.log(JSON.stringify({ drill, expectAt, read: latest && latest.at, http: reading.http, problems, ...result }, null, 2));
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p.text}`);
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`::error::fpl-health monitor failed: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 2;
  });
}
