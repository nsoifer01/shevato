// Score Predictor — server-side data collector (scheduled).
//
// Why this exists: the browser page grades picks against odds it freezes at
// kickoff and scores it fetches from The Odds API, but that /scores endpoint
// only returns games from the last 3 days, and odds vanish from the feed once
// a match starts. So anything not captured while a tab happened to be open
// (inside those windows) was lost forever. This function removes the tab from
// data collection entirely: on a schedule it freezes upcoming odds into a
// locks blob and accumulates final scores into a results blob, both of which
// the page reads on load. Once stored, data persists indefinitely.
//
// Both feeds come from The Odds API (the same provider the fixtures come
// from), so team names line up exactly on both sides. Scores are the feed's
// final score: for group-stage matches that is the 90-minute result; knockout
// matches that go to extra time would include it (that feed exposes no
// regulation-only split).
//
// Required env var (set in the Netlify UI, never in the repo):
//   ODDS_API_KEY — The Odds API key
//
// Credits: to avoid burning the monthly Odds API quota, each feed is only
// called when it can actually do something — scores only when a known match
// kicked off in the last 3 days and is not yet final; odds only when a known
// match kicks off within 12 hours or the last snapshot is over 6 hours old.
// A cold start (no data yet) calls both once to bootstrap.

import { getStore } from '@netlify/blobs';
import { STORE_NAME, RESULTS_KEY, LOCKS_KEY, CONFIG_KEY, matchKey, oddsConsensus } from './lib/wc-store.mjs';

export const config = { schedule: '0 * * * *' };

const SPORT = 'soccer_fifa_world_cup';
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=`;
const SCORES_URL = `https://api.the-odds-api.com/v4/sports/${SPORT}/scores/?daysFrom=3&apiKey=`;

const DAY = 86400000;
const HOUR = 3600000;

export default async function handler() {
  const store = getStore(STORE_NAME);

  // The key lives in the config blob (this site does not inject env vars into
  // functions). It was written once through this function's own store; env var
  // is still preferred if it ever starts resolving.
  const cfg = (await store.get(CONFIG_KEY, { type: 'json' })) || {};
  const key = process.env.ODDS_API_KEY || cfg.oddsApiKey;
  if (!key) return new Response('Odds API key not configured (env or config blob)', { status: 500 });

  const prevResults = (await store.get(RESULTS_KEY, { type: 'json' })) || {};
  const prevLocks = (await store.get(LOCKS_KEY, { type: 'json' })) || {};
  const results = { ...(prevResults.results || {}) };
  const locks = { ...(prevLocks.locks || {}) };
  const now = Date.now();

  // Kickoff time per known match, from everything we have already stored.
  const commenceByKey = {};
  for (const [k, v] of Object.entries(locks)) if (v.commence_time) commenceByKey[k] = v.commence_time;
  for (const [k, v] of Object.entries(results)) if (v.commence_time) commenceByKey[k] = v.commence_time;
  const cold = Object.keys(commenceByKey).length === 0;

  // Scores: worth a call only if some known match kicked off within the /scores
  // window (3 days) and is not yet recorded as final.
  const scoresNeeded = Object.entries(commenceByKey).some(function ([k, c]) {
    const t = Date.parse(c);
    return t <= now && t >= now - 3 * DAY && !(results[k] && results[k].completed);
  });
  // Odds: worth a call if a known match kicks off soon, or our snapshot is stale
  // (stale also re-discovers newly listed fixtures).
  const upcomingSoon = Object.values(locks).some(function (l) {
    const t = Date.parse(l.commence_time);
    return t > now && t <= now + 12 * HOUR;
  });
  const oddsStale = !prevLocks.updated || (now - Date.parse(prevLocks.updated)) > 6 * HOUR;

  const scoresMsg = (cold || scoresNeeded) ? await collectScores(key, results, store) : 'skipped';
  const locksMsg = (cold || upcomingSoon || oddsStale) ? await snapshotOdds(key, locks, store, now) : 'skipped';

  return new Response(`ok: results ${scoresMsg}, locks ${locksMsg}`);
}

// Accumulate final scores from The Odds API /scores into the results blob.
async function collectScores(key, results, store) {
  let arr;
  try {
    const res = await fetch(SCORES_URL + encodeURIComponent(key));
    if (!res.ok) return `scores ${res.status}`;
    arr = await res.json();
  } catch (err) {
    return `scores failed: ${err.message}`;
  }

  let n = 0;
  for (const g of arr || []) {
    if (!g || !g.home_team || !g.away_team || !g.commence_time || !g.scores) continue;
    let hs = null, as = null;
    for (const s of g.scores) {
      const v = Number(s.score);
      if (s.name === g.home_team) hs = v;
      else if (s.name === g.away_team) as = v;
    }
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    results[matchKey(g.home_team, g.away_team, g.commence_time)] = {
      home_score: hs,
      away_score: as,
      completed: !!g.completed,
      home_team: g.home_team,
      away_team: g.away_team,
      commence_time: g.commence_time,
    };
    n += 1;
  }

  await store.setJSON(RESULTS_KEY, { updated: new Date().toISOString(), results });
  return String(n);
}

// Freeze median odds for every not-yet-started match into the locks blob so the
// page can compute picks from the server alone. Once a match kicks off it drops
// out of the odds feed, so its last snapshot persists untouched.
async function snapshotOdds(key, locks, store, now) {
  let events;
  try {
    const res = await fetch(ODDS_URL + encodeURIComponent(key));
    if (!res.ok) return `odds ${res.status}`;
    events = await res.json();
  } catch (err) {
    return `odds failed: ${err.message}`;
  }

  let n = 0;
  for (const ev of events || []) {
    if (!ev || !ev.id || !ev.home_team || !ev.away_team || !ev.commence_time) continue;
    if (new Date(ev.commence_time).getTime() <= now) continue; // started: keep frozen lock
    const o = oddsConsensus(ev);
    if (!Number.isFinite(o.home) || !Number.isFinite(o.away)) continue;
    locks[matchKey(ev.home_team, ev.away_team, ev.commence_time)] = {
      home: o.home,
      away: o.away,
      commence_time: ev.commence_time,
      home_team: ev.home_team,
      away_team: ev.away_team,
    };
    n += 1;
  }

  await store.setJSON(LOCKS_KEY, { updated: new Date().toISOString(), locks });
  return String(n);
}
