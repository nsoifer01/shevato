// Score Predictor — public read endpoint for collected 90-minute results.
//
// Serves whatever wc-results-cron.mjs has accumulated in the Blob store. The
// page fetches this on load and on Load/Refresh, then merges each result onto
// the matching fixture by team + date. No key required: reading finals is
// harmless and lets the scoreboard fill in even for a visitor who has never
// entered an Odds API key.

import { getStore } from '@netlify/blobs';
import { STORE_NAME, RESULTS_KEY, LOCKS_KEY } from './lib/wc-store.mjs';

export default async function handler(req) {
  // Temporary diagnostic: report which env vars reach this function at runtime
  // (booleans only, never values). Remove once the cron env issue is resolved.
  if (req && typeof req.url === 'string' && req.url.includes('debug=env')) {
    const names = Object.keys(process.env)
      .filter((k) => !/AWS|LAMBDA|SECRET|SESSION|TOKEN|KEY|PASS/i.test(k))
      .sort();
    return new Response(JSON.stringify({
      ODDS_API_KEY: !!process.env.ODDS_API_KEY,
      FIREBASE_API_KEY: !!process.env.FIREBASE_API_KEY,
      total_env_keys: Object.keys(process.env).length,
      safe_names: names,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  const store = getStore(STORE_NAME);
  const resultsBlob = (await store.get(RESULTS_KEY, { type: 'json' })) || {};
  const locksBlob = (await store.get(LOCKS_KEY, { type: 'json' })) || {};

  const data = {
    updated: resultsBlob.updated || null,
    locks: locksBlob.locks || {},
    results: resultsBlob.results || {},
  };

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short cache: results change at most once an hour, and the client also
      // holds its own copy, so a few minutes of edge cache is free freshness.
      'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
    },
  });
}
