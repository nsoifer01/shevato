'use strict';

// Each shape detector takes a sorted-by-episode array of {episode, rating, votes}
// and returns true if the season's curve fits that shape. Shapes are not
// mutually exclusive — a season can match several at once.

const DEFAULTS = {
  // "Rising" — non-decreasing across the entire season.
  rising: {},
  // "Consistent" — all episodes above a high floor with a tight spread.
  consistent: { floor: 8.0, maxRange: 0.5 },
  // "Slow burn" — second half meaningfully better than first half.
  slowBurn: { delta: 0.6 },
  // "Big finale" — finale is the peak AND well above the season average.
  bigFinale: { aboveAvg: 0.5 },
  // "Rebound" — has a real dip in the middle but recovers past the start.
  rebound: { dipDepth: 0.4, recoveryAboveStart: 0.2 },
};

function isRising(episodes) {
  for (let i = 1; i < episodes.length; i++) {
    if (episodes[i].rating < episodes[i - 1].rating) return false;
  }
  return true;
}

function isConsistent(episodes, opts = DEFAULTS.consistent) {
  if (episodes.length === 0) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const e of episodes) {
    if (e.rating < min) min = e.rating;
    if (e.rating > max) max = e.rating;
  }
  return min >= opts.floor && (max - min) <= opts.maxRange;
}

function halves(episodes) {
  const n = episodes.length;
  if (n < 4) return null;
  const mid = Math.floor(n / 2);
  const first = episodes.slice(0, mid);
  const second = episodes.slice(n - mid); // symmetric — for odd n, drop the middle ep
  return { first, second };
}

function avg(episodes) {
  let s = 0;
  for (const e of episodes) s += e.rating;
  return s / episodes.length;
}

function isSlowBurn(episodes, opts = DEFAULTS.slowBurn) {
  const h = halves(episodes);
  if (!h) return false;
  return avg(h.second) - avg(h.first) >= opts.delta;
}

function isBigFinale(episodes, opts = DEFAULTS.bigFinale) {
  if (episodes.length < 4) return false;
  const finale = episodes[episodes.length - 1].rating;
  let max = -Infinity;
  for (const e of episodes) {
    if (e.rating > max) max = e.rating;
  }
  // Finale must be (tied for) the peak.
  if (finale < max) return false;
  return finale - avg(episodes) >= opts.aboveAvg;
}

function isRebound(episodes, opts = DEFAULTS.rebound) {
  if (episodes.length < 5) return false;
  const start = episodes[0].rating;
  const end = episodes[episodes.length - 1].rating;
  // The dip must sit somewhere in the interior, not at the edges.
  let minIdx = -1;
  let minRating = Infinity;
  for (let i = 1; i < episodes.length - 1; i++) {
    if (episodes[i].rating < minRating) {
      minRating = episodes[i].rating;
      minIdx = i;
    }
  }
  if (minIdx < 0) return false;
  const dip = Math.min(start, end) - minRating;
  return dip >= opts.dipDepth && (end - start) >= opts.recoveryAboveStart;
}

function detectShapes(episodes) {
  const tags = [];
  if (isRising(episodes)) tags.push('rising');
  if (isConsistent(episodes)) tags.push('consistent');
  if (isSlowBurn(episodes)) tags.push('slow-burn');
  if (isBigFinale(episodes)) tags.push('big-finale');
  if (isRebound(episodes)) tags.push('rebound');
  return tags;
}

// Walk the (series -> season -> episodes) map and return one record per
// season that matches at least one shape.
//
// Filters:
//   minEpisodes — skip seasons with fewer rated episodes than this.
//   minVotes    — every episode must have at least this many votes (low-vote
//                 ratings are noisy and not meaningful).
function findMatches(seriesById, episodesBySeries, opts = {}) {
  const minEpisodes = opts.minEpisodes ?? 4;
  const minVotes = opts.minVotes ?? 100;
  const matches = [];

  for (const [seriesId, bySeason] of episodesBySeries) {
    const meta = seriesById.get(seriesId);
    if (!meta) continue;

    for (const [season, eps] of bySeason) {
      if (eps.length < minEpisodes) continue;
      eps.sort((a, b) => a.episode - b.episode);

      let minSeasonVotes = Infinity;
      for (const e of eps) {
        if (e.votes < minSeasonVotes) minSeasonVotes = e.votes;
      }
      if (minSeasonVotes < minVotes) continue;

      const shapes = detectShapes(eps);
      if (shapes.length === 0) continue;

      const ratings = eps.map((e) => e.rating);
      const seasonAvg = ratings.reduce((s, r) => s + r, 0) / ratings.length;

      matches.push({
        seriesId,
        title: meta.title,
        year: meta.year,
        type: meta.type,
        genres: meta.genres || [],
        season,
        episodes: eps.map(({ episode, rating, votes, tconst }) => ({
          episode, rating, votes, tconst,
        })),
        firstRating: ratings[0],
        lastRating: ratings[ratings.length - 1],
        avgRating: Math.round(seasonAvg * 100) / 100,
        minVotes: minSeasonVotes,
        shapes,
      });
    }
  }
  return matches;
}

module.exports = {
  isRising,
  isConsistent,
  isSlowBurn,
  isBigFinale,
  isRebound,
  detectShapes,
  findMatches,
  // Back-compat with earlier API name.
  isNonDecreasing: isRising,
};
