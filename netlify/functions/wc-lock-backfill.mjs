// Score Predictor - one-time manual odds backfill (removed after use).
import { getStore } from '@netlify/blobs';
import { STORE_NAME, LOCKS_KEY } from './lib/wc-store.mjs';
const MANUAL_LOCKS = {
  "uruguay|spain|2026-06-27": {
    "home": 2.9,
    "away": 2.55,
    "commence_time": "2026-06-27T00:00:00Z",
    "home_team": "Uruguay",
    "away_team": "Spain"
  }
};
export default async function handler() {
  const store = getStore(STORE_NAME);
  const prev = (await store.get(LOCKS_KEY, { type: 'json' })) || {};
  const locks = { ...(prev.locks || {}), ...MANUAL_LOCKS };
  await store.setJSON(LOCKS_KEY, { updated: new Date().toISOString(), locks });
  return new Response(`ok: added ${Object.keys(MANUAL_LOCKS).length}, total ${Object.keys(locks).length}`);
}
