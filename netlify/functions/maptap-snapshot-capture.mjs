// MapTap Rivals: scheduled pre-game prediction snapshots (see
// lib/maptap-snapshots.mjs for what a run does and why it runs here).
// Three runs before 10:00 UTC, the moment tomorrow can start at UTC+14; the
// first that succeeds stores the snapshot and the others find it.

import { SNAPSHOT_STORE, captureRun } from './lib/maptap-snapshots.mjs';

export default async () => {
  const { getStore } = await import('@netlify/blobs');
  const summary = await captureRun({
    store: getStore(SNAPSHOT_STORE),
    allowlist: process.env.MAPTAP_SNAPSHOT_UIDS,
  });
  // Log statuses and counts only: never usernames or uids.
  console.log('maptap-snapshot-capture', JSON.stringify((summary.results || []).map((r) => ({
    target: r.target, status: r.status, puzzleDated: r.puzzleDated, players: r.players, missing: r.missing,
  })).concat(summary.disabled ? [{ status: 'disabled' }] : [])));
  return new Response('ok', { status: 200 });
};

export const config = { schedule: '17 3,6,9 * * *' };
