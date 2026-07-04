// Shared constants + match-key helper for the Score Predictor result store.
//
// The page (which talks to The Odds API) and this collector (which talks to
// API-Football) never share match ids, so results are keyed by a normalized
// "home|away|date" string that both providers can produce. The identical
// normalizer is mirrored in tools/score-predictor.html (WC_normTeam); keep the
// two in sync — the alias table is the only place provider spellings diverge.

export const STORE_NAME = 'score-predictor';
export const RESULTS_KEY = 'results';
export const LOCKS_KEY = 'locks';
// Holds { oddsApiKey } written out-of-band (netlify blobs:set) because this
// site does not inject env vars into functions. Never served to the browser.
export const CONFIG_KEY = 'config';

// Median of a numeric list (used for consensus odds across bookmakers).
export function median(arr) {
  const xs = (arr || []).filter(function (n) { return Number.isFinite(n); }).sort(function (a, b) { return a - b; });
  if (!xs.length) return NaN;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Median home/away decimal odds across an Odds API event's bookmakers. Mirrors
// the page's consensus() so server-frozen locks yield the same picks the page
// would have computed from an open tab.
export function oddsConsensus(event) {
  const home = [], away = [];
  ((event && event.bookmakers) || []).forEach(function (bk) {
    const m = (bk.markets || []).find(function (x) { return x.key === 'h2h'; });
    if (!m) return;
    (m.outcomes || []).forEach(function (o) {
      if (o.name === event.home_team || o.name === 'HOME') home.push(o.price);
      else if (o.name === event.away_team || o.name === 'AWAY') away.push(o.price);
    });
  });
  return { home: median(home), away: median(away) };
}

// Provider spellings that differ for the same national team, folded to one
// canonical token. Keys are already normalized (lower-case, no punctuation).
const ALIASES = {
  unitedstates: 'usa',
  us: 'usa',
  korearepublic: 'southkorea',
  republicofkorea: 'southkorea',
  korea: 'southkorea',
  iranislamicrepublic: 'iran',
  iriran: 'iran',
  czechia: 'czechrepublic',
  cotedivoire: 'ivorycoast',
  capeverdeislands: 'capeverde',
  bosniaandherzegovina: 'bosnia',
  drcongo: 'congodr',
  democraticrepublicofcongo: 'congodr',
};

// Lower-case, strip diacritics, drop everything but a-z0-9, then de-alias.
export function normTeam(name) {
  const base = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return ALIASES[base] || base;
}

// UTC calendar date of a kickoff, used to disambiguate repeat pairings. The
// client tolerates a +/- 1 day slip so provider timezone rounding never
// splits a match into two keys.
export function matchDate(commence) {
  return String(commence || '').slice(0, 10);
}

export function matchKey(home, away, commence) {
  return `${normTeam(home)}|${normTeam(away)}|${matchDate(commence)}`;
}
