// Score Predictor — one-time historical results backfill (manual).
//
// The Odds API /scores feed only reaches back 3 days, so matches that finished
// before the cron started collecting (and are now outside that window) can
// never be recovered from it and sit forever as "awaiting result". This
// function fills that gap once from football-data.org, which carries the full
// World Cup schedule with final scores. Group-stage games are all 90 minutes,
// so football-data's score.fullTime is exactly the regulation result.
//
// It only ADDS results for matches not already present, so it never disturbs
// the live data the cron collects. Results are keyed the same way (normalized
// home|away|date), and the team names line up with The Odds API after the
// shared normalizer, so the page merges them onto the matching fixtures.
//
// One-time use: invoke with the football-data token as a query param, e.g.
//   curl -X POST '.../wc-backfill?token=YOUR_FOOTBALL_DATA_TOKEN'
// The function is removed once the backfill has run.

import { getStore } from '@netlify/blobs';
import { STORE_NAME, RESULTS_KEY, matchKey } from './lib/wc-store.mjs';

const FD_URL = 'https://api.football-data.org/v4/competitions/WC/matches';

export default async function handler(req) {
  let token = null;
  try { token = new URL(req.url).searchParams.get('token'); } catch (e) { /* no url */ }
  if (!token) return new Response('token query param required', { status: 400 });

  let body;
  try {
    const res = await fetch(FD_URL, { headers: { 'X-Auth-Token': token } });
    if (!res.ok) return new Response(`football-data ${res.status}`, { status: 502 });
    body = await res.json();
  } catch (err) {
    return new Response(`fetch failed: ${err.message}`, { status: 502 });
  }

  const store = getStore(STORE_NAME);
  const prev = (await store.get(RESULTS_KEY, { type: 'json' })) || {};
  const results = { ...(prev.results || {}) };

  let added = 0, skipped = 0;
  for (const m of body.matches || []) {
    if (m.status !== 'FINISHED') continue;
    const ft = m.score && m.score.fullTime;
    if (!ft || ft.home == null || ft.away == null) continue;
    const home = m.homeTeam && m.homeTeam.name;
    const away = m.awayTeam && m.awayTeam.name;
    const commence = m.utcDate;
    if (!home || !away || !commence) continue;

    const k = matchKey(home, away, commence);
    if (results[k]) { skipped += 1; continue; } // keep live cron data untouched
    results[k] = {
      home_score: Number(ft.home),
      away_score: Number(ft.away),
      completed: true,
      home_team: home,
      away_team: away,
      commence_time: commence,
      src: 'fd',
    };
    added += 1;
  }

  await store.setJSON(RESULTS_KEY, { updated: new Date().toISOString(), results });
  return new Response(`ok: added ${added}, skipped ${skipped} (already present), total ${Object.keys(results).length}`);
}
