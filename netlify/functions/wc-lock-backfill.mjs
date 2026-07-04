// Score Predictor - one-time manual odds backfill (removed after use).
//
// The owner supplied pre-kickoff odds for the completed matches that had no
// captured pick (odds leave the feed at kickoff and the cron started July 4).
// These are written as locks so those matches show a graded pick. Keyed the
// same way as results (normalized home|away|date) so each result attaches.
// The cron only ADDS upcoming locks, so these persist untouched.

import { getStore } from '@netlify/blobs';
import { STORE_NAME, LOCKS_KEY } from './lib/wc-store.mjs';

const MANUAL_LOCKS = {
  "switzerland|algeria|2026-07-03": {
    "home": 1.97,
    "away": 4.35,
    "commence_time": "2026-07-03T03:00:00Z",
    "home_team": "Switzerland",
    "away_team": "Algeria"
  },
  "portugal|croatia|2026-07-02": {
    "home": 1.68,
    "away": 5.6,
    "commence_time": "2026-07-02T23:00:00Z",
    "home_team": "Portugal",
    "away_team": "Croatia"
  },
  "spain|austria|2026-07-02": {
    "home": 1.35,
    "away": 9.9,
    "commence_time": "2026-07-02T19:00:00Z",
    "home_team": "Spain",
    "away_team": "Austria"
  },
  "usa|bosniaherzegovina|2026-07-02": {
    "home": 1.38,
    "away": 9.0,
    "commence_time": "2026-07-02T00:00:00Z",
    "home_team": "United States",
    "away_team": "Bosnia-Herzegovina"
  },
  "belgium|senegal|2026-07-01": {
    "home": 2.2,
    "away": 3.55,
    "commence_time": "2026-07-01T20:00:00Z",
    "home_team": "Belgium",
    "away_team": "Senegal"
  },
  "england|congodr|2026-07-01": {
    "home": 1.28,
    "away": 13.34,
    "commence_time": "2026-07-01T16:00:00Z",
    "home_team": "England",
    "away_team": "Congo DR"
  },
  "mexico|ecuador|2026-07-01": {
    "home": 2.25,
    "away": 3.9,
    "commence_time": "2026-07-01T02:00:00Z",
    "home_team": "Mexico",
    "away_team": "Ecuador"
  },
  "france|sweden|2026-06-30": {
    "home": 1.3,
    "away": 10.5,
    "commence_time": "2026-06-30T21:00:00Z",
    "home_team": "France",
    "away_team": "Sweden"
  },
  "ivorycoast|norway|2026-06-30": {
    "home": 3.52,
    "away": 2.15,
    "commence_time": "2026-06-30T17:00:00Z",
    "home_team": "Ivory Coast",
    "away_team": "Norway"
  },
  "netherlands|morocco|2026-06-30": {
    "home": 2.15,
    "away": 3.77,
    "commence_time": "2026-06-30T01:00:00Z",
    "home_team": "Netherlands",
    "away_team": "Morocco"
  },
  "germany|paraguay|2026-06-29": {
    "home": 1.37,
    "away": 8.7,
    "commence_time": "2026-06-29T20:30:00Z",
    "home_team": "Germany",
    "away_team": "Paraguay"
  },
  "brazil|japan|2026-06-29": {
    "home": 1.7,
    "away": 5.25,
    "commence_time": "2026-06-29T17:00:00Z",
    "home_team": "Brazil",
    "away_team": "Japan"
  },
  "southafrica|canada|2026-06-28": {
    "home": 6.0,
    "away": 1.66,
    "commence_time": "2026-06-28T19:00:00Z",
    "home_team": "South Africa",
    "away_team": "Canada"
  },
  "algeria|austria|2026-06-28": {
    "home": 3.55,
    "away": 3.67,
    "commence_time": "2026-06-28T02:00:00Z",
    "home_team": "Algeria",
    "away_team": "Austria"
  },
  "jordan|argentina|2026-06-28": {
    "home": 20.3,
    "away": 1.13,
    "commence_time": "2026-06-28T02:00:00Z",
    "home_team": "Jordan",
    "away_team": "Argentina"
  },
  "colombia|portugal|2026-06-27": {
    "home": 3.45,
    "away": 2.05,
    "commence_time": "2026-06-27T23:30:00Z",
    "home_team": "Colombia",
    "away_team": "Portugal"
  },
  "congodr|uzbekistan|2026-06-27": {
    "home": 1.7,
    "away": 5.19,
    "commence_time": "2026-06-27T23:30:00Z",
    "home_team": "Congo DR",
    "away_team": "Uzbekistan"
  },
  "croatia|ghana|2026-06-27": {
    "home": 1.8,
    "away": 5.59,
    "commence_time": "2026-06-27T21:00:00Z",
    "home_team": "Croatia",
    "away_team": "Ghana"
  },
  "panama|england|2026-06-27": {
    "home": 17.0,
    "away": 1.15,
    "commence_time": "2026-06-27T21:00:00Z",
    "home_team": "Panama",
    "away_team": "England"
  },
  "newzealand|belgium|2026-06-27": {
    "home": 14.05,
    "away": 1.18,
    "commence_time": "2026-06-27T03:00:00Z",
    "home_team": "New Zealand",
    "away_team": "Belgium"
  }
};

export default async function handler() {
  const store = getStore(STORE_NAME);
  const prev = (await store.get(LOCKS_KEY, { type: 'json' })) || {};
  const locks = { ...(prev.locks || {}), ...MANUAL_LOCKS };
  await store.setJSON(LOCKS_KEY, { updated: new Date().toISOString(), locks });
  return new Response(`ok: added ${Object.keys(MANUAL_LOCKS).length}, total ${Object.keys(locks).length}`);
}
