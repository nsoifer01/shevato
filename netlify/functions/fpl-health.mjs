// The FPL Planner's health probe, every six hours on Netlify's scheduler, and
// every hour while it is failing
// (netlify/functions/lib/fpl-health-run.mjs explains why it moved off GitHub
// Actions, how a duplicate run is prevented and how a failure is reported).
// A failed probe is logged as an error and returns 500, so it is visible in
// the function's log and in fpl-health-status, and, when
// FPL_HEALTH_GITHUB_TOKEN is set, starts the GitHub workflow that keeps the
// incident issue and emails the owner.

import { HEALTH_STORE, openStrongStore, runScheduledProbe, githubDispatchAlert } from './lib/fpl-health-run.mjs';
import { ARCHIVE_STORE } from './lib/fpl-archive-stage.mjs';
import { STORE_NAME } from './lib/fpl-cache.mjs';

export default async () => {
  const { getStore } = await import('@netlify/blobs');
  const alert = githubDispatchAlert({
    token: process.env.FPL_HEALTH_GITHUB_TOKEN,
    repo: process.env.FPL_HEALTH_GITHUB_REPO || undefined,
  });
  const result = await runScheduledProbe({ store: openStrongStore(getStore, HEALTH_STORE), alert, archiveStore: openStrongStore(getStore, ARCHIVE_STORE), proxyStore: openStrongStore(getStore, STORE_NAME) });
  if (result.skipped) {
    console.log('fpl-health', result.skipped);
    return new Response(result.skipped, { status: 200 });
  }
  const line = JSON.stringify({ at: result.at, ok: result.ok, failed: result.failed, durationMs: result.durationMs });
  if (result.ok) console.log('fpl-health OK', line);
  else console.error('fpl-health FAILED', line);
  return new Response(line, { status: result.ok ? 200 : 500, headers: { 'content-type': 'application/json' } });
};

// Hourly at :41. A run probes at 00:41, 06:41, 12:41 and 18:41 UTC (the slots
// the GitHub cron used), and in the hours between only while the last result
// is red (lib/fpl-health-run.mjs slotFor), so a recovery is seen within an hour.
export const config = { schedule: '41 * * * *' };
