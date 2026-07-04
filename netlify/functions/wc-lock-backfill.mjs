// Score Predictor - one-time manual odds backfill (removed after use).
//
// Owner-supplied pre-kickoff odds for the June 11-26 group games that had no
// captured pick. Written as locks keyed like results (normalized home|away|date),
// oriented to the result home/away. The cron only ADDS upcoming locks, so these
// persist.

import { getStore } from '@netlify/blobs';
import { STORE_NAME, LOCKS_KEY } from './lib/wc-store.mjs';

const MANUAL_LOCKS = {
  "mexico|southafrica|2026-06-11": {
    "home": 1.4,
    "away": 8.0,
    "commence_time": "2026-06-11T19:00:00Z",
    "home_team": "Mexico",
    "away_team": "South Africa"
  },
  "southkorea|czechrepublic|2026-06-12": {
    "home": 2.7,
    "away": 2.7,
    "commence_time": "2026-06-12T02:00:00Z",
    "home_team": "South Korea",
    "away_team": "Czechia"
  },
  "canada|bosniaherzegovina|2026-06-12": {
    "home": 2.35,
    "away": 3.1,
    "commence_time": "2026-06-12T19:00:00Z",
    "home_team": "Canada",
    "away_team": "Bosnia-Herzegovina"
  },
  "usa|paraguay|2026-06-13": {
    "home": 2.05,
    "away": 4.0,
    "commence_time": "2026-06-13T01:00:00Z",
    "home_team": "United States",
    "away_team": "Paraguay"
  },
  "qatar|switzerland|2026-06-13": {
    "home": 5.5,
    "away": 1.67,
    "commence_time": "2026-06-13T19:00:00Z",
    "home_team": "Qatar",
    "away_team": "Switzerland"
  },
  "brazil|morocco|2026-06-13": {
    "home": 1.69,
    "away": 5.0,
    "commence_time": "2026-06-13T22:00:00Z",
    "home_team": "Brazil",
    "away_team": "Morocco"
  },
  "haiti|scotland|2026-06-14": {
    "home": 7.5,
    "away": 1.48,
    "commence_time": "2026-06-14T01:00:00Z",
    "home_team": "Haiti",
    "away_team": "Scotland"
  },
  "australia|turkey|2026-06-14": {
    "home": 2.9,
    "away": 2.45,
    "commence_time": "2026-06-14T04:00:00Z",
    "home_team": "Australia",
    "away_team": "Turkey"
  },
  "germany|curacao|2026-06-14": {
    "home": 1.11,
    "away": 19.0,
    "commence_time": "2026-06-14T17:00:00Z",
    "home_team": "Germany",
    "away_team": "Cura\u00e7ao"
  },
  "netherlands|japan|2026-06-14": {
    "home": 1.57,
    "away": 5.5,
    "commence_time": "2026-06-14T20:00:00Z",
    "home_team": "Netherlands",
    "away_team": "Japan"
  },
  "ivorycoast|ecuador|2026-06-14": {
    "home": 2.85,
    "away": 2.5,
    "commence_time": "2026-06-14T23:00:00Z",
    "home_team": "Ivory Coast",
    "away_team": "Ecuador"
  },
  "sweden|tunisia|2026-06-15": {
    "home": 1.69,
    "away": 4.9,
    "commence_time": "2026-06-15T02:00:00Z",
    "home_team": "Sweden",
    "away_team": "Tunisia"
  },
  "spain|capeverde|2026-06-15": {
    "home": 1.08,
    "away": 26.0,
    "commence_time": "2026-06-15T16:00:00Z",
    "home_team": "Spain",
    "away_team": "Cape Verde Islands"
  },
  "belgium|egypt|2026-06-15": {
    "home": 1.45,
    "away": 7.0,
    "commence_time": "2026-06-15T19:00:00Z",
    "home_team": "Belgium",
    "away_team": "Egypt"
  },
  "saudiarabia|uruguay|2026-06-15": {
    "home": 7.5,
    "away": 1.43,
    "commence_time": "2026-06-15T22:00:00Z",
    "home_team": "Saudi Arabia",
    "away_team": "Uruguay"
  },
  "iran|newzealand|2026-06-16": {
    "home": 1.83,
    "away": 4.5,
    "commence_time": "2026-06-16T01:00:00Z",
    "home_team": "Iran",
    "away_team": "New Zealand"
  },
  "france|senegal|2026-06-16": {
    "home": 1.38,
    "away": 8.5,
    "commence_time": "2026-06-16T19:00:00Z",
    "home_team": "France",
    "away_team": "Senegal"
  },
  "iraq|norway|2026-06-16": {
    "home": 7.0,
    "away": 1.48,
    "commence_time": "2026-06-16T22:00:00Z",
    "home_team": "Iraq",
    "away_team": "Norway"
  },
  "argentina|algeria|2026-06-17": {
    "home": 1.25,
    "away": 12.0,
    "commence_time": "2026-06-17T01:00:00Z",
    "home_team": "Argentina",
    "away_team": "Algeria"
  },
  "austria|jordan|2026-06-17": {
    "home": 1.38,
    "away": 8.5,
    "commence_time": "2026-06-17T04:00:00Z",
    "home_team": "Austria",
    "away_team": "Jordan"
  },
  "portugal|congodr|2026-06-17": {
    "home": 1.22,
    "away": 13.0,
    "commence_time": "2026-06-17T17:00:00Z",
    "home_team": "Portugal",
    "away_team": "Congo DR"
  },
  "england|croatia|2026-06-17": {
    "home": 1.67,
    "away": 5.25,
    "commence_time": "2026-06-17T20:00:00Z",
    "home_team": "England",
    "away_team": "Croatia"
  },
  "ghana|panama|2026-06-17": {
    "home": 1.8,
    "away": 4.6,
    "commence_time": "2026-06-17T23:00:00Z",
    "home_team": "Ghana",
    "away_team": "Panama"
  },
  "uzbekistan|colombia|2026-06-18": {
    "home": 6.0,
    "away": 1.57,
    "commence_time": "2026-06-18T02:00:00Z",
    "home_team": "Uzbekistan",
    "away_team": "Colombia"
  },
  "czechrepublic|southafrica|2026-06-18": {
    "home": 1.74,
    "away": 4.9,
    "commence_time": "2026-06-18T16:00:00Z",
    "home_team": "Czechia",
    "away_team": "South Africa"
  },
  "switzerland|bosniaherzegovina|2026-06-18": {
    "home": 1.83,
    "away": 4.3,
    "commence_time": "2026-06-18T19:00:00Z",
    "home_team": "Switzerland",
    "away_team": "Bosnia-Herzegovina"
  },
  "canada|qatar|2026-06-18": {
    "home": 1.63,
    "away": 5.6,
    "commence_time": "2026-06-18T22:00:00Z",
    "home_team": "Canada",
    "away_team": "Qatar"
  },
  "mexico|southkorea|2026-06-19": {
    "home": 1.69,
    "away": 5.1,
    "commence_time": "2026-06-19T01:00:00Z",
    "home_team": "Mexico",
    "away_team": "South Korea"
  },
  "usa|australia|2026-06-19": {
    "home": 1.67,
    "away": 5.25,
    "commence_time": "2026-06-19T19:00:00Z",
    "home_team": "United States",
    "away_team": "Australia"
  },
  "scotland|morocco|2026-06-19": {
    "home": 4.3,
    "away": 1.91,
    "commence_time": "2026-06-19T22:00:00Z",
    "home_team": "Scotland",
    "away_team": "Morocco"
  },
  "brazil|haiti|2026-06-20": {
    "home": 1.07,
    "away": 29.0,
    "commence_time": "2026-06-20T00:30:00Z",
    "home_team": "Brazil",
    "away_team": "Haiti"
  },
  "turkey|paraguay|2026-06-20": {
    "home": 2.85,
    "away": 2.55,
    "commence_time": "2026-06-20T03:00:00Z",
    "home_team": "Turkey",
    "away_team": "Paraguay"
  },
  "netherlands|sweden|2026-06-20": {
    "home": 1.8,
    "away": 4.6,
    "commence_time": "2026-06-20T17:00:00Z",
    "home_team": "Netherlands",
    "away_team": "Sweden"
  },
  "germany|ivorycoast|2026-06-20": {
    "home": 1.31,
    "away": 10.0,
    "commence_time": "2026-06-20T20:00:00Z",
    "home_team": "Germany",
    "away_team": "Ivory Coast"
  },
  "ecuador|curacao|2026-06-21": {
    "home": 1.28,
    "away": 11.0,
    "commence_time": "2026-06-21T00:00:00Z",
    "home_team": "Ecuador",
    "away_team": "Cura\u00e7ao"
  },
  "tunisia|japan|2026-06-21": {
    "home": 4.6,
    "away": 1.8,
    "commence_time": "2026-06-21T04:00:00Z",
    "home_team": "Tunisia",
    "away_team": "Japan"
  },
  "spain|saudiarabia|2026-06-21": {
    "home": 1.14,
    "away": 17.0,
    "commence_time": "2026-06-21T16:00:00Z",
    "home_team": "Spain",
    "away_team": "Saudi Arabia"
  },
  "belgium|iran|2026-06-21": {
    "home": 1.48,
    "away": 7.0,
    "commence_time": "2026-06-21T19:00:00Z",
    "home_team": "Belgium",
    "away_team": "Iran"
  },
  "uruguay|capeverde|2026-06-21": {
    "home": 1.15,
    "away": 16.0,
    "commence_time": "2026-06-21T22:00:00Z",
    "home_team": "Uruguay",
    "away_team": "Cape Verde Islands"
  },
  "newzealand|egypt|2026-06-22": {
    "home": 6.0,
    "away": 1.59,
    "commence_time": "2026-06-22T01:00:00Z",
    "home_team": "New Zealand",
    "away_team": "Egypt"
  },
  "argentina|austria|2026-06-22": {
    "home": 1.33,
    "away": 9.5,
    "commence_time": "2026-06-22T17:00:00Z",
    "home_team": "Argentina",
    "away_team": "Austria"
  },
  "france|iraq|2026-06-22": {
    "home": 1.1,
    "away": 23.0,
    "commence_time": "2026-06-22T21:00:00Z",
    "home_team": "France",
    "away_team": "Iraq"
  },
  "norway|senegal|2026-06-23": {
    "home": 2.6,
    "away": 2.9,
    "commence_time": "2026-06-23T00:00:00Z",
    "home_team": "Norway",
    "away_team": "Senegal"
  },
  "jordan|algeria|2026-06-23": {
    "home": 6.0,
    "away": 1.57,
    "commence_time": "2026-06-23T03:00:00Z",
    "home_team": "Jordan",
    "away_team": "Algeria"
  },
  "portugal|uzbekistan|2026-06-23": {
    "home": 1.15,
    "away": 16.0,
    "commence_time": "2026-06-23T17:00:00Z",
    "home_team": "Portugal",
    "away_team": "Uzbekistan"
  },
  "england|ghana|2026-06-23": {
    "home": 1.29,
    "away": 10.5,
    "commence_time": "2026-06-23T20:00:00Z",
    "home_team": "England",
    "away_team": "Ghana"
  },
  "panama|croatia|2026-06-23": {
    "home": 8.5,
    "away": 1.38,
    "commence_time": "2026-06-23T23:00:00Z",
    "home_team": "Panama",
    "away_team": "Croatia"
  },
  "colombia|congodr|2026-06-24": {
    "home": 1.38,
    "away": 8.5,
    "commence_time": "2026-06-24T02:00:00Z",
    "home_team": "Colombia",
    "away_team": "Congo DR"
  },
  "bosniaherzegovina|qatar|2026-06-24": {
    "home": 1.83,
    "away": 4.5,
    "commence_time": "2026-06-24T19:00:00Z",
    "home_team": "Bosnia-Herzegovina",
    "away_team": "Qatar"
  },
  "switzerland|canada|2026-06-24": {
    "home": 1.91,
    "away": 4.0,
    "commence_time": "2026-06-24T19:00:00Z",
    "home_team": "Switzerland",
    "away_team": "Canada"
  },
  "morocco|haiti|2026-06-24": {
    "home": 1.18,
    "away": 15.0,
    "commence_time": "2026-06-24T22:00:00Z",
    "home_team": "Morocco",
    "away_team": "Haiti"
  },
  "scotland|brazil|2026-06-24": {
    "home": 10.0,
    "away": 1.31,
    "commence_time": "2026-06-24T22:00:00Z",
    "home_team": "Scotland",
    "away_team": "Brazil"
  },
  "czechrepublic|mexico|2026-06-25": {
    "home": 3.3,
    "away": 2.2,
    "commence_time": "2026-06-25T01:00:00Z",
    "home_team": "Czechia",
    "away_team": "Mexico"
  },
  "southafrica|southkorea|2026-06-25": {
    "home": 4.3,
    "away": 1.87,
    "commence_time": "2026-06-25T01:00:00Z",
    "home_team": "South Africa",
    "away_team": "South Korea"
  },
  "curacao|ivorycoast|2026-06-25": {
    "home": 9.0,
    "away": 1.36,
    "commence_time": "2026-06-25T20:00:00Z",
    "home_team": "Cura\u00e7ao",
    "away_team": "Ivory Coast"
  },
  "ecuador|germany|2026-06-25": {
    "home": 7.0,
    "away": 1.48,
    "commence_time": "2026-06-25T20:00:00Z",
    "home_team": "Ecuador",
    "away_team": "Germany"
  },
  "japan|sweden|2026-06-25": {
    "home": 2.6,
    "away": 2.8,
    "commence_time": "2026-06-25T23:00:00Z",
    "home_team": "Japan",
    "away_team": "Sweden"
  },
  "tunisia|netherlands|2026-06-25": {
    "home": 8.5,
    "away": 1.38,
    "commence_time": "2026-06-25T23:00:00Z",
    "home_team": "Tunisia",
    "away_team": "Netherlands"
  },
  "paraguay|australia|2026-06-26": {
    "home": 2.5,
    "away": 2.9,
    "commence_time": "2026-06-26T02:00:00Z",
    "home_team": "Paraguay",
    "away_team": "Australia"
  },
  "turkey|usa|2026-06-26": {
    "home": 3.4,
    "away": 2.15,
    "commence_time": "2026-06-26T02:00:00Z",
    "home_team": "Turkey",
    "away_team": "United States"
  },
  "norway|france|2026-06-26": {
    "home": 7.5,
    "away": 1.43,
    "commence_time": "2026-06-26T19:00:00Z",
    "home_team": "Norway",
    "away_team": "France"
  },
  "senegal|iraq|2026-06-26": {
    "home": 1.4,
    "away": 8.0,
    "commence_time": "2026-06-26T19:00:00Z",
    "home_team": "Senegal",
    "away_team": "Iraq"
  }
};

export default async function handler() {
  const store = getStore(STORE_NAME);
  const prev = (await store.get(LOCKS_KEY, { type: 'json' })) || {};
  const locks = { ...(prev.locks || {}), ...MANUAL_LOCKS };
  await store.setJSON(LOCKS_KEY, { updated: new Date().toISOString(), locks });
  return new Response(`ok: added ${Object.keys(MANUAL_LOCKS).length}, total ${Object.keys(locks).length}`);
}
