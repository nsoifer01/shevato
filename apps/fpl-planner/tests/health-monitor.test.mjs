// The health probe's incident keeper (scripts/health-monitor.mjs), which
// .github/workflows/fpl-health.yml runs when the Netlify probe starts it and on
// GitHub's own schedule. Hermetic: GitHub's issues API is an in-memory fake.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assess, reconcile, drillStatus, MARKER, DRILL_MARKER, STALE_AFTER_HOURS } from '../scripts/health-monitor.mjs';

const NOW = Date.parse('2026-10-10T19:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const latest = (over = {}) => ({ at: iso(NOW - 20 * 60e3), slot: '2026-10-10T18', ok: true, durationMs: 13472, failed: [], checks: [{ name: 'a', ok: true }], lines: ['OK: every invariant holds.'], ...over });
const red = (failed = [{ name: 'every fixture of a finished gameweek has been played', saw: '2 unplayed', expected: '0' }]) =>
  ({ http: 503, body: { ok: false, reason: `${failed.length} invariant(s) failed`, latest: latest({ ok: false, failed }) } });
const green = () => ({ http: 200, body: { ok: true, reason: 'every invariant holds', latest: latest() } });

// GitHub's issues API, enough of it: issues with comments, open and closed.
function fakeGithub() {
  const issues = [];
  const calls = [];
  const res = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const api = async (path, init = {}) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${path}`);
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === '/issues?state=open&per_page=100') return res(200, issues.filter((i) => i.state === 'open'));
    if (path === '/issues' && method === 'POST') {
      const issue = { number: issues.length + 1, title: body.title, body: body.body, state: 'open', comments: [] };
      issues.push(issue);
      return res(201, issue);
    }
    const m = path.match(/^\/issues\/(\d+)(\/comments)?/);
    const issue = m && issues.find((i) => i.number === Number(m[1]));
    if (!issue) return res(404, {});
    if (m[2] && method === 'GET') return res(200, issue.comments);
    if (m[2] && method === 'POST') { issue.comments.push({ body: body.body }); return res(201, {}); }
    if (method === 'PATCH') { Object.assign(issue, body); return res(200, issue); }
    return res(400, {});
  };
  return { api, issues, calls };
}

const run = (gh, reading, over = {}) => {
  const { problems, latest: l } = assess({ ...reading, nowMs: NOW });
  return reconcile({ problems, latest: l, api: gh.api, mention: 'owner', nowIso: iso(NOW), runUrl: 'https://github.com/o/r/actions/runs/1', ...over });
};

test('a failure opens one issue that names the failing check, what it saw, when, and mentions the owner', async () => {
  const gh = fakeGithub();
  const r = await run(gh, red());
  assert.equal(r.action, 'opened');
  const [issue] = gh.issues;
  assert.ok(issue.title.startsWith(`${MARKER} every fixture of a finished gameweek has been played`));
  assert.match(issue.body, /^@owner /, 'the mention is what reaches the owner\'s inbox');
  assert.match(issue.body, /saw 2 unplayed, expected 0/);
  assert.match(issue.body, /Last probe: 2026-10-10T18:40:00.000Z \(slot 2026-10-10T18\), FAILED, 13472 ms/);
  assert.match(issue.body, /actions\/runs\/1/);
  assert.match(issue.body, /fpl-health-status/);
});

test('the same failure again, from either trigger and on a later slot, adds nothing; a different failure comments once', async () => {
  const gh = fakeGithub();
  await run(gh, red());
  assert.equal((await run(gh, red())).action, 'unchanged');
  const later = red();
  later.body.latest.slot = '2026-10-11T00';
  assert.equal((await run(gh, later)).action, 'unchanged');
  assert.equal(gh.issues.length, 1);
  assert.equal(gh.issues[0].comments.length, 0);

  const other = red([{ name: 'the projection pool has not collapsed', saw: 'best-11 12.0', expected: '> 30' }]);
  assert.equal((await run(gh, other)).action, 'commented');
  assert.equal((await run(gh, other)).action, 'unchanged');
  assert.equal(gh.issues.length, 1, 'never a second issue');
  assert.equal(gh.issues[0].comments.length, 1);
  assert.match(gh.issues[0].comments[0].body, /@owner Still failing, and what is wrong has changed/);
});

test('recovery comments and closes the incident; health with no incident touches nothing', async () => {
  const gh = fakeGithub();
  await run(gh, red());
  const r = await run(gh, green());
  assert.equal(r.action, 'closed');
  assert.equal(gh.issues[0].state, 'closed');
  assert.match(gh.issues[0].comments.at(-1).body, /Recovered/);
  const n = gh.calls.length;
  assert.equal((await run(gh, green())).action, 'healthy');
  assert.deepEqual(gh.calls.slice(n), ['GET /issues?state=open&per_page=100'], 'one read, no writes');
  // A new failure after a recovery is a new incident.
  assert.equal((await run(gh, red())).action, 'opened');
  assert.equal(gh.issues.length, 2);
});

test('a late backstop cannot call an old result healthy, whatever the endpoint answers', () => {
  const old = green();
  old.body.latest.at = iso(NOW - (STALE_AFTER_HOURS + 0.5) * 3600e3);
  const { problems } = assess({ ...old, nowMs: NOW });
  assert.deepEqual(problems.map((p) => p.key), ['stale'], 'a 200 does not cancel staleness by this clock');
  assert.match(problems[0].text, /Netlify has stopped running the scheduled function/);
  // Inside the window it is fine.
  assert.deepEqual(assess({ ...green(), nowMs: NOW }).problems, []);
});

test('a dead endpoint, a missing run, a killed run and a broken alert channel are each an incident', () => {
  assert.deepEqual(assess({ http: null, body: null, error: 'fetch failed', nowMs: NOW }).problems.map((p) => p.key), ['endpoint']);
  assert.deepEqual(assess({ http: 502, body: null, nowMs: NOW }).problems.map((p) => p.key), ['endpoint']);
  assert.deepEqual(assess({ http: 503, body: { ok: false, reason: 'no probe has run yet' }, nowMs: NOW }).problems.map((p) => p.key), ['no-run']);
  const killed = green();
  killed.http = 503;
  killed.body.reason = 'the run for slot 2026-10-11T00 started at 2026-10-11T00:41:00Z and never recorded a result';
  const k = assess({ ...killed, nowMs: NOW }).problems;
  assert.deepEqual(k.map((p) => p.key), ['endpoint-unhealthy']);
  assert.match(k[0].text, /never recorded a result/);
  const token = green();
  token.body.latest.alert = { ok: false, error: 'workflow check: HTTP 401' };
  const t = assess({ ...token, nowMs: NOW }).problems;
  assert.deepEqual(t.map((p) => p.key), ['alert-channel']);
  assert.match(t[0].text, /FPL_HEALTH_GITHUB_TOKEN/);
});

test('a drill runs the whole path on its own issue and never touches a real incident', async () => {
  const gh = fakeGithub();
  await run(gh, red());
  const fail = drillStatus('failure', iso(NOW));
  assert.equal((await run(gh, fail, { marker: DRILL_MARKER })).action, 'opened');
  assert.equal((await run(gh, fail, { marker: DRILL_MARKER })).action, 'unchanged');
  assert.equal((await run(gh, drillStatus('recovery', iso(NOW)), { marker: DRILL_MARKER })).action, 'closed');
  assert.deepEqual(gh.issues.map((i) => [i.title.split(' ')[0] + (i.title.startsWith(DRILL_MARKER) ? ' drill]' : ''), i.state]), [['[fpl-health]', 'open'], ['[fpl-health drill]', 'closed']]);
  assert.throws(() => drillStatus('nonsense', iso(NOW)), /failure or recovery/);
});

test('a GitHub error is thrown, not swallowed, so the run goes red', async () => {
  const api = async () => new Response('{}', { status: 500 });
  const { problems, latest: l } = assess({ ...red(), nowMs: NOW });
  await assert.rejects(reconcile({ problems, latest: l, api }), /list issues: HTTP 500/);
});
