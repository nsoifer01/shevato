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
  // "Front-loaded" — first half meaningfully better than second half.
  frontLoaded: { delta: 0.6 },
  // "Declining" — non-increasing across the season AND first strictly > last.
  declining: {},
  // "Bad finale" — finale is the trough AND well below the season average.
  badFinale: { belowAvg: 0.5 },
  // "Rollercoaster" — many large adjacent-direction flips with wide range.
  rollercoaster: { minFlips: 4, minRange: 1.2, minAvgDiff: 0.4, ignoreBelow: 0.2 },
  // "Mid-peak" — peak sits in the interior; both edges sit well below it.
  midPeak: { peakAboveStart: 0.7, peakAboveEnd: 0.7 },
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

function isFrontLoaded(episodes, opts = DEFAULTS.frontLoaded) {
  const h = halves(episodes);
  if (!h) return false;
  return avg(h.first) - avg(h.second) >= opts.delta;
}

function isDeclining(episodes) {
  if (episodes.length < 2) return false;
  for (let i = 1; i < episodes.length; i++) {
    if (episodes[i].rating > episodes[i - 1].rating) return false;
  }
  // Must actually decline overall — flat seasons don't count.
  return episodes[0].rating > episodes[episodes.length - 1].rating;
}

function isBadFinale(episodes, opts = DEFAULTS.badFinale) {
  if (episodes.length < 4) return false;
  const finale = episodes[episodes.length - 1].rating;
  let min = Infinity;
  for (const e of episodes) {
    if (e.rating < min) min = e.rating;
  }
  // Finale must be (tied for) the trough.
  if (finale > min) return false;
  return avg(episodes) - finale >= opts.belowAvg;
}

function isRollercoaster(episodes, opts = DEFAULTS.rollercoaster) {
  const n = episodes.length;
  if (n < 6) return false;
  let flips = 0;
  let prevSign = 0;
  let totalAbs = 0;
  for (let i = 1; i < n; i++) {
    const diff = episodes[i].rating - episodes[i - 1].rating;
    totalAbs += Math.abs(diff);
    if (Math.abs(diff) < opts.ignoreBelow) continue;
    const sign = diff > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) flips++;
    prevSign = sign;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const e of episodes) {
    if (e.rating < min) min = e.rating;
    if (e.rating > max) max = e.rating;
  }
  const avgAbsDiff = totalAbs / (n - 1);
  return flips >= opts.minFlips
      && avgAbsDiff >= opts.minAvgDiff
      && (max - min) >= opts.minRange;
}

function isMidPeak(episodes, opts = DEFAULTS.midPeak) {
  const n = episodes.length;
  if (n < 5) return false;
  let maxIdx = 0;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (episodes[i].rating > max) {
      max = episodes[i].rating;
      maxIdx = i;
    }
  }
  // Peak must sit in the middle half of the season — not just "interior",
  // since a peak at episode 2 of 7 is technically interior but visually
  // front-loaded, not mid.
  const pos = maxIdx / (n - 1);
  if (pos <= 0.25 || pos >= 0.75) return false;
  const start = episodes[0].rating;
  const end = episodes[n - 1].rating;
  return (max - start) >= opts.peakAboveStart && (max - end) >= opts.peakAboveEnd;
}

function detectShapes(episodes) {
  const tags = [];
  if (isRising(episodes)) tags.push('rising');
  if (isConsistent(episodes)) tags.push('consistent');
  if (isSlowBurn(episodes)) tags.push('slow-burn');
  if (isBigFinale(episodes)) tags.push('big-finale');
  if (isRebound(episodes)) tags.push('rebound');
  if (isFrontLoaded(episodes)) tags.push('front-loaded');
  if (isDeclining(episodes)) tags.push('declining');
  if (isBadFinale(episodes)) tags.push('bad-finale');
  if (isRollercoaster(episodes)) tags.push('rollercoaster');
  if (isMidPeak(episodes)) tags.push('mid-peak');
  return tags;
}

// Walk the (series -> season -> episodes) map and return one record per
// season that passes the vote/episode floor. Shape matching is descriptive,
// not gating — seasons with no shape match are still emitted with shapes: []
// so the app can search the full IMDb catalog.
//
// Filters:
//   minEpisodes — skip seasons with fewer rated episodes than this.
//   minVotes    — every episode must have at least this many votes (low-vote
//                 ratings are noisy and not meaningful).
//   relaxedGenres / relaxedMinVotes — apply a lower per-episode vote floor
//                 when the series is tagged with any of these genres.
//                 Reality/competition shows get a fraction of the per-episode
//                 votes scripted shows do, so the standard floor wipes them
//                 out entirely; a relaxed floor lets them surface.
function findMatches(seriesById, episodesBySeries, opts = {}) {
  const minEpisodes = opts.minEpisodes ?? 4;
  const minVotes = opts.minVotes ?? 100;
  const relaxedGenres = opts.relaxedGenres instanceof Set
    ? opts.relaxedGenres
    : new Set(opts.relaxedGenres || []);
  const relaxedMinVotes = opts.relaxedMinVotes ?? minVotes;

  const seasons = []; // { seriesId, season, eps, shapes, minSeasonVotes }

  for (const [seriesId, bySeason] of episodesBySeries) {
    const meta = seriesById.get(seriesId);
    if (!meta) continue;
    let floor = minVotes;
    if (relaxedGenres.size > 0 && meta.genres) {
      for (const g of meta.genres) {
        if (relaxedGenres.has(g)) { floor = relaxedMinVotes; break; }
      }
    }
    for (const [season, eps] of bySeason) {
      if (eps.length < minEpisodes) continue;
      eps.sort((a, b) => a.episode - b.episode);

      let minSeasonVotes = Infinity;
      for (const e of eps) {
        if (e.votes < minSeasonVotes) minSeasonVotes = e.votes;
      }
      if (minSeasonVotes < floor) continue;

      const shapes = detectShapes(eps);
      seasons.push({ seriesId, season, eps, shapes, minSeasonVotes });
    }
  }

  const matches = [];
  for (const { seriesId, season, eps, shapes, minSeasonVotes } of seasons) {
    const meta = seriesById.get(seriesId);
    const ratings = eps.map((e) => e.rating);
    const seasonAvg = ratings.reduce((s, r) => s + r, 0) / ratings.length;

    // seasonYear = earliest air year across the season's episodes. We use
    // min (rather than the first episode's year) so an out-of-order ep
    // doesn't pull the year forward; if no episode carries a year, we
    // fall back to null and the UI uses the show's start year (`year`).
    let seasonYear = null;
    for (const e of eps) {
      if (e.year && (!seasonYear || e.year < seasonYear)) seasonYear = e.year;
    }

    matches.push({
      seriesId,
      title: meta.title,
      year: meta.year,
      // Per-season air year — distinct from `year` (show start year). The
      // UI prefers seasonYear everywhere a single season is displayed and
      // falls back to `year` when the build pipeline didn't supply one.
      seasonYear,
      type: meta.type,
      genres: meta.genres || [],
      season,
      // Project to the minimal shape the UI actually reads. We deliberately
      // drop `tconst` — it's the IMDb episode ID we used to join the ratings
      // and titles tables during build, but the front-end never reads it,
      // so shipping it inflates data.json by ~1.5MB across ~126K episodes.
      // We also drop the per-episode `year` because seasonYear above
      // captures the only year the UI needs.
      episodes: eps.map(({ episode, rating, votes, name }) => {
        const ep = { episode, rating, votes };
        if (name) ep.name = name;
        return ep;
      }),
      firstRating: ratings[0],
      lastRating: ratings[ratings.length - 1],
      avgRating: Math.round(seasonAvg * 100) / 100,
      minVotes: minSeasonVotes,
      shapes,
    });
  }

  return matches;
}

module.exports = {
  isRising,
  isConsistent,
  isSlowBurn,
  isBigFinale,
  isRebound,
  isFrontLoaded,
  isDeclining,
  isBadFinale,
  isRollercoaster,
  isMidPeak,
  detectShapes,
  findMatches,
  // Back-compat with earlier API name.
  isNonDecreasing: isRising,
};
