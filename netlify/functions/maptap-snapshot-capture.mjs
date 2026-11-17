// MapTap Rivals: scheduled pre-game prediction snapshots (see
// lib/maptap-snapshots.mjs for what a run does and why it runs here).
// Three runs before 10:00 UTC, the moment tomorrow can start at UTC+14; the
// first that succeeds stores the snapshot and the others find it.
//
// Failures surface three ways: this log line (Netlify function logs), the
// per-account `status/<uid>` record the app shows on the profile card ("last
// run ...: puzzle unavailable"), and a day with no snapshot at all. A store
// that cannot be read throws, so Netlify records the run itself as failed.

import { SNAPSHOT_STORE, captureRun } from './lib/maptap-snapshots.mjs';

export default async () => {
  const { getStore } = await import('@netlify/blobs');
  const summary = await captureRun({
    store: getStore({ name: SNAPSHOT_STORE, consistency: 'strong' }),
    allowlist: process.env.MAPTAP_SNAPSHOT_UIDS,
  });
  // Statuses and counts only: never usernames or uids.
  console.log('maptap-snapshot-capture', JSON.stringify({
    disabled: !!summary.disabled,
    swept: summary.swept || 0,
    runs: (summary.results || []).map((r) => ({
      target: r.target, status: r.status, puzzleDated: r.puzzleDated, complete: r.complete,
      players: r.players, roster: r.roster, unread: r.unread,
    })),
  }));
  return new Response('ok', { status: 200 });
};

export const config = { schedule: '17 3,6,9 * * *' };
