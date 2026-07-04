// Score Predictor — server-side data collector (scheduled).
//
// Scores come from football-data.org: it carries the full World Cup schedule
// (no 3-day window) and lets us compute the 90-minute (regulation) score, which
// is the only number this tool cares about. The Odds API is used only for odds,
// frozen into locks before kickoff so the page can show picks without a tab
// open. Both feeds come from services whose team names line up with The Odds
// API fixtures after the shared normalizer.
//
// This site does not inject env vars into functions, so both credentials live
// in the Blob `config` (fields oddsApiKey, footballDataToken), written once via
// the one-time ?setkey= / ?setfd= query params below.

import { getStore } from '@netlify/blobs';
import { STORE_NAME, RESULTS_KEY, LOCKS_KEY, CONFIG_KEY, matchKey, oddsConsensus } from './lib/wc-store.mjs';

export const config = { schedule: '0 * * * *' };

const SPORT = 'soccer_fifa_world_cup';
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds/?regions=eu&markets=h2h&oddsFormat=decimal&apiKey=`;
const FD_URL = 'https://api.football-data.org/v4/competitions/WC/matches';
const HOUR = 3600000;

// 90-minute score from a football-data score object. regularTime is populated
// for some knockout games but null for others, so fall back to
// fullTime minus extra-time minus penalties (fullTime bundles them all in).
function score90(s) {
  if (!s) return null;
  const rt = s.regularTime;
  if (rt && rt.home != null && rt.away != null) {
    return { home: Number(rt.home), away: Number(rt.away) };
  }
  const ft = s.fullTime;
  if (!ft || ft.home == null || ft.away == null) return null;
  let h = Number(ft.home), a = Number(ft.away);
  const et = s.extraTime, pen = s.penalties;
  if (et && et.home != null) { h -= Number(et.home); a -= Number(et.away); }
  if (pen && pen.home != null) { h -= Number(pen.home); a -= Number(pen.away); }
  return { home: h, away: a };
}

export default async function handler(req) {
  const store = getStore(STORE_NAME);

  // One-time credential setup (env vars are not injected into functions here).
  try {
    const u = new URL(req.url);
    const setfd = u.searchParams.get('setfd');
    const setkey = u.searchParams.get('setkey');
    if (setfd || setkey) {
      const c = (await store.get(CONFIG_KEY, { type: 'json' })) || {};
      if (setfd) c.footballDataToken = setfd;
      if (setkey) c.oddsApiKey = setkey;
      await store.setJSON(CONFIG_KEY, c);
      return new Response('config stored');
    }
  } catch (e) { /* scheduled run: no url */ }

  const cfg = (await store.get(CONFIG_KEY, { type: 'json' })) || {};
  const oddsKey = process.env.ODDS_API_KEY || cfg.oddsApiKey;
  const fdToken = process.env.FD_TOKEN || cfg.footballDataToken;

  const prevLocks = (await store.get(LOCKS_KEY, { type: 'json' })) || {};
  const locks = { ...(prevLocks.locks || {}) };
  const now = Date.now();

  // Scores: football-data every run (free, generous limits, full history).
  const resultsMsg = fdToken ? await collectResults(fdToken, store) : 'no fd token';

  // Odds: gated to save Odds API credits — only when a match kicks off within
  // 12h or the snapshot is over 6h old (or nothing is locked yet).
  const upcomingSoon = Object.values(locks).some(function (l) {
    const t = Date.parse(l.commence_time);
    return t > now && t <= now + 12 * HOUR;
  });
  const oddsStale = !prevLocks.updated || (now - Date.parse(prevLocks.updated)) > 6 * HOUR;
  const cold = Object.keys(locks).length === 0;
  const locksMsg = (oddsKey && (cold || upcomingSoon || oddsStale))
    ? await snapshotOdds(oddsKey, locks, store, now)
    : 'skipped';

  return new Response(`ok: results ${resultsMsg}, locks ${locksMsg}`);
}

// Rebuild the results blob from football-data's finished matches, storing the
// 90-minute score. Rebuilt fresh each run so a corrected score replaces any
// earlier value; skipped entirely if the feed returns nothing (never wipes).
async function collectResults(token, store) {
  let body;
  try {
    const res = await fetch(FD_URL, { headers: { 'X-Auth-Token': token } });
    if (!res.ok) return `fd ${res.status}`;
    body = await res.json();
  } catch (err) {
    return `fd failed: ${err.message}`;
  }

  const finished = (body.matches || []).filter(function (m) { return m.status === 'FINISHED'; });
  if (!finished.length) return 'no finished games';

  const results = {};
  for (const m of finished) {
    const s90 = score90(m.score);
    if (!s90 || !Number.isFinite(s90.home) || !Number.isFinite(s90.away)) continue;
    const home = m.homeTeam && m.homeTeam.name;
    const away = m.awayTeam && m.awayTeam.name;
    const commence = m.utcDate;
    if (!home || !away || !commence) continue;
    results[matchKey(home, away, commence)] = {
      home_score: s90.home,
      away_score: s90.away,
      completed: true,
      home_team: home,
      away_team: away,
      commence_time: commence,
    };
  }

  await store.setJSON(RESULTS_KEY, { updated: new Date().toISOString(), results });
  return String(Object.keys(results).length);
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
