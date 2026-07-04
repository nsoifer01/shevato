// Score Predictor - one-time manual odds backfill (removed after use).
//
// Adds the owner's browser odds for three Jul-3/4 matches that were only in the
// owner's localStorage, so they grade on any browser. Keyed like results
// (normalized home|away|date). The cron only ADDS upcoming locks, so these stay.

import { getStore } from '@netlify/blobs';
import { STORE_NAME, LOCKS_KEY } from './lib/wc-store.mjs';

const MANUAL_LOCKS = {
  "colombia|ghana|2026-07-04": {
    "home": 1.43,
    "away": 8.57,
    "commence_time": "2026-07-04T01:30:00Z",
    "home_team": "Colombia",
    "away_team": "Ghana"
  },
  "argentina|capeverde|2026-07-03": {
    "home": 1.14,
    "away": 22.0,
    "commence_time": "2026-07-03T22:00:00Z",
    "home_team": "Argentina",
    "away_team": "Cape Verde Islands"
  },
  "australia|egypt|2026-07-03": {
    "home": 3.65,
    "away": 2.38,
    "commence_time": "2026-07-03T18:00:00Z",
    "home_team": "Australia",
    "away_team": "Egypt"
  }
};

export default async function handler() {
  const store = getStore(STORE_NAME);
  const prev = (await store.get(LOCKS_KEY, { type: 'json' })) || {};
  const locks = { ...(prev.locks || {}), ...MANUAL_LOCKS };
  await store.setJSON(LOCKS_KEY, { updated: new Date().toISOString(), locks });
  return new Response(`ok: added ${Object.keys(MANUAL_LOCKS).length}, total ${Object.keys(locks).length}`);
}
