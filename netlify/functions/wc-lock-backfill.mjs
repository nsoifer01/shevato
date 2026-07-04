// Score Predictor - one-time manual odds backfill (removed after use).
import { getStore } from '@netlify/blobs';
import { STORE_NAME, LOCKS_KEY } from './lib/wc-store.mjs';
const MANUAL_LOCKS = {
  "capeverde|saudiarabia|2026-06-27": {
    "home": 1.3,
    "away": 10.0,
    "commence_time": "2026-06-27T00:00:00Z",
    "home_team": "Cape Verde Islands",
    "away_team": "Saudi Arabia"
  }
};
export default async function handler() {
  const store = getStore(STORE_NAME);
  const prev = (await store.get(LOCKS_KEY, { type: 'json' })) || {};
  const locks = { ...(prev.locks || {}), ...MANUAL_LOCKS };
  await store.setJSON(LOCKS_KEY, { updated: new Date().toISOString(), locks });
  return new Response(`ok: added ${Object.keys(MANUAL_LOCKS).length}, total ${Object.keys(locks).length}`);
}
