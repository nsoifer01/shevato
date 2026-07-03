// Score Predictor — server-side results collector (scheduled).
//
// Why this exists: the browser page grades picks against final scores, but
// The Odds API /scores endpoint only returns games from the last 3 days, so
// a match whose final was never captured while a tab happened to be open
// (and inside that 3-day window) could never be back-filled and was stuck
// showing "awaiting result" forever. This function removes the tab entirely
// from data collection: it runs on a schedule, pulls the World Cup fixtures
// from API-Football, and accumulates results into a Netlify Blob that the
// page reads on load. Once a result is stored it persists indefinitely.
//
// It also fixes the knockout problem: we store the 90-minute (regulation)
// score only. API-Football exposes score.fulltime as the score at the end of
// normal time, kept separate from score.extratime and score.penalty, so a
// knockout that finishes 1-1 after 90 and 2-1 after extra time is stored as
// 1-1. That is the only number the page cares about.
//
// Required env var (set in the Netlify UI, never in the repo):
//   APIFOOTBALL_KEY   — api-sports.io key (header x-apisports-key)
// Optional overrides:
//   WC_APIFOOTBALL_LEAGUE  (default 1 = FIFA World Cup)
//   WC_APIFOOTBALL_SEASON  (default 2026)

import { getStore } from '@netlify/blobs';
import { STORE_NAME, RESULTS_KEY, LOCKS_KEY, matchKey, oddsConsensus } from './lib/wc-store.mjs';

// Hourly. Idle runs are cheap: one API-Football call returns the whole
// tournament, and results only ever change right after a match, so an hour
// of latency is invisible while the 3-day-window problem disappears entirely.
export const config = { schedule: '0 * * * *' };

const API_URL = 'https://v3.football.api-sports.io/fixtures';
const LEAGUE = process.env.WC_APIFOOTBALL_LEAGUE || '1';
const SEASON = process.env.WC_APIFOOTBALL_SEASON || '2026';

// The Odds API — same feed the page uses, polled server-side so odds are
// frozen into locks before kickoff even when no tab is open. Without this the
// page could never show picks for a match nobody had open at kickoff.
const ODDS_URL = 'https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=';

// API-Football status short codes. Once a match is at or past full time the
// 90-minute score can no longer change, so score.fulltime is final even while
// the game continues into extra time or penalties.
const POST_REGULATION = new Set(['FT', 'AET', 'PEN', 'ET', 'BT', 'P', 'LIVE']);

export default async function handler() {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) {
    return new Response('APIFOOTBALL_KEY is not configured', { status: 500 });
  }

  let body;
  try {
    const res = await fetch(`${API_URL}?league=${LEAGUE}&season=${SEASON}`, {
      headers: { 'x-apisports-key': key },
    });
    if (!res.ok) {
      return new Response(`api-football ${res.status}`, { status: 502 });
    }
    body = await res.json();
  } catch (err) {
    return new Response(`fetch failed: ${err.message}`, { status: 502 });
  }

  const store = getStore(STORE_NAME);
  const prev = (await store.get(RESULTS_KEY, { type: 'json' })) || {};
  const results = { ...(prev.results || {}) };

  let stored = 0;
  for (const item of body.response || []) {
    const home = item?.teams?.home?.name;
    const away = item?.teams?.away?.name;
    const commence = item?.fixture?.date;
    const status = item?.fixture?.status?.short;
    const ft = item?.score?.fulltime;
    if (!home || !away || !commence || !ft) continue;

    const hs = Number(ft.home);
    const as = Number(ft.away);
    // fulltime is null until 90 minutes are played; guard against half-time.
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;

    const completed = POST_REGULATION.has(status);
    const k = matchKey(home, away, commence);
    results[k] = {
      home_score: hs,
      away_score: as,
      completed,
      status,
      home_team: home,
      away_team: away,
      commence_time: commence,
    };
    stored += 1;
  }

  await store.setJSON(RESULTS_KEY, {
    updated: new Date().toISOString(),
    league: LEAGUE,
    season: SEASON,
    results,
  });

  const locked = await snapshotOdds(store);

  return new Response(`ok: scanned ${(body.response || []).length}, results ${stored}, locks ${locked}`);
}

// Freeze median odds for every not-yet-started match into the locks blob so the
// page can compute picks from the server alone. Best-effort: a failure here
// must not affect the results already stored above. Once a match kicks off it
// drops out of the odds feed, so its last snapshot persists untouched.
async function snapshotOdds(store) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return 'skipped (no ODDS_API_KEY)';

  let events;
  try {
    const res = await fetch(ODDS_URL + encodeURIComponent(key));
    if (!res.ok) return `odds ${res.status}`;
    events = await res.json();
  } catch (err) {
    return `odds fetch failed: ${err.message}`;
  }

  const prev = (await store.get(LOCKS_KEY, { type: 'json' })) || {};
  const locks = { ...(prev.locks || {}) };
  const now = Date.now();

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
