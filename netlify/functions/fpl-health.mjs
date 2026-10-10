// The FPL Planner's health probe, every six hours on Netlify's scheduler
// (netlify/functions/lib/fpl-health-run.mjs explains why it moved off GitHub
// Actions, how a duplicate run is prevented and how a failure is reported).
// A failed probe is logged as an error and returns 500, so it is visible in
// the function's log and in fpl-health-status, and opens a GitHub issue when
// FPL_HEALTH_GITHUB_TOKEN is set.

import { HEALTH_STORE, runScheduledProbe, githubIssueAlert } from './lib/fpl-health-run.mjs';

export default async () => {
  const { getStore } = await import('@netlify/blobs');
  const alert = githubIssueAlert({
    token: process.env.FPL_HEALTH_GITHUB_TOKEN,
    repo: process.env.FPL_HEALTH_GITHUB_REPO || undefined,
  });
  const result = await runScheduledProbe({ store: getStore(HEALTH_STORE), alert });
  if (result.skipped) {
    console.log('fpl-health', result.skipped);
    return new Response(result.skipped, { status: 200 });
  }
  const line = JSON.stringify({ at: result.at, ok: result.ok, failed: result.failed, durationMs: result.durationMs });
  if (result.ok) console.log('fpl-health OK', line);
  else console.error('fpl-health FAILED', line);
  return new Response(line, { status: result.ok ? 200 : 500, headers: { 'content-type': 'application/json' } });
};

// 00:41, 06:41, 12:41 and 18:41 UTC, the slots the GitHub cron used.
export const config = { schedule: '41 */6 * * *' };
