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
  // "Big finale" — finale beats every other episode by at least one IMDb step (0.1).
  bigFinale: { minMargin: 0.1 },
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
  // "U-shaped" — opener and finale are the season's peaks. Both
  // STRICTLY exceed every interior episode (no ties — if an interior
  // ep matches an endpoint, that endpoint isn't really a peak), and
  // at least one interior dip sits >= dipDepth below opener OR finale.
  // Distinct from rebound (which requires end > start) and from
  // front-loaded (which has no strong finale).
  uShaped: { dipDepth: 0.5 },
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
  let secondMax = -Infinity;
  for (let i = 0; i < episodes.length - 1; i++) {
    if (episodes[i].rating > secondMax) secondMax = episodes[i].rating;
  }
  // IMDb ratings are 0.1 increments, so the difference is always a multiple
  // of 0.1 — round to avoid floating-point drift (e.g. 9.0 - 8.9 = 0.0999...).
  return Math.round((finale - secondMax) * 10) / 10 >= opts.minMargin;
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

function isUShaped(episodes, opts = DEFAULTS.uShaped) {
  const n = episodes.length;
  if (n < 3) return false;
  const opener = episodes[0].rating;
  const finale = episodes[n - 1].rating;
  let dipFound = false;
  // Opener and finale must STRICTLY exceed every interior episode —
  // they are the season's peaks, not tied for peak. (e.g. Black Mirror
  // S2 has E1=E2=7.9, which means E1 doesn't dominate, so it shouldn't
  // count as U-shaped.)
  for (let i = 1; i < n - 1; i++) {
    const r = episodes[i].rating;
    if (r >= opener || r >= finale) return false;
    if ((opener - r) >= opts.dipDepth || (finale - r) >= opts.dipDepth) {
      dipFound = true;
    }
  }
  return dipFound;
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
  if (isUShaped(episodes)) tags.push('u-shaped');
  return tags;
}

// Compute per-shape confidence in [0,1] — how far each matched shape exceeds
// its classifier threshold. Capped at 1.0; 0 means the shape was not matched.
// cap values are chosen so ~95th-percentile margin maps to ~1.0.
function shapeConfidence(episodes) {
  const conf = {};
  const h = halves(episodes);

  if (isRising(episodes)) {
    // Margin = total positive climb across all steps / max possible climb.
    const climb = episodes[episodes.length - 1].rating - episodes[0].rating;
    conf.rising = Math.min(1, Math.max(0, climb) / 2.0);
  }

  if (isConsistent(episodes)) {
    const opts = DEFAULTS.consistent;
    let min = Infinity, max = -Infinity;
    for (const e of episodes) {
      if (e.rating < min) min = e.rating;
      if (e.rating > max) max = e.rating;
    }
    const rangeMargin = opts.maxRange - (max - min);
    const floorMargin = min - opts.floor;
    conf.consistent = Math.min(1, (rangeMargin / opts.maxRange * 0.5) + (Math.min(floorMargin, 1.0) * 0.5));
  }

  if (isSlowBurn(episodes) && h) {
    const opts = DEFAULTS.slowBurn;
    const delta = avg(h.second) - avg(h.first);
    conf['slow-burn'] = Math.min(1, (delta - opts.delta) / 1.5 + 0.1);
  }

  if (isBigFinale(episodes)) {
    const opts = DEFAULTS.bigFinale;
    const finale = episodes[episodes.length - 1].rating;
    let secondMax = -Infinity;
    for (let i = 0; i < episodes.length - 1; i++) {
      if (episodes[i].rating > secondMax) secondMax = episodes[i].rating;
    }
    const margin = Math.round((finale - secondMax) * 10) / 10;
    conf['big-finale'] = Math.min(1, (margin - opts.minMargin) / 2.0 + 0.1);
  }

  if (isRebound(episodes)) {
    const opts = DEFAULTS.rebound;
    const start = episodes[0].rating;
    const end = episodes[episodes.length - 1].rating;
    let minRating = Infinity;
    for (let i = 1; i < episodes.length - 1; i++) {
      if (episodes[i].rating < minRating) minRating = episodes[i].rating;
    }
    const dip = Math.min(start, end) - minRating;
    const recovery = end - start;
    conf.rebound = Math.min(1, ((dip - opts.dipDepth) / 1.5 + (recovery - opts.recoveryAboveStart) / 1.5) / 2 + 0.1);
  }

  if (isFrontLoaded(episodes) && h) {
    const opts = DEFAULTS.frontLoaded;
    const delta = avg(h.first) - avg(h.second);
    conf['front-loaded'] = Math.min(1, (delta - opts.delta) / 1.5 + 0.1);
  }

  if (isDeclining(episodes)) {
    const drop = episodes[0].rating - episodes[episodes.length - 1].rating;
    conf.declining = Math.min(1, drop / 2.0);
  }

  if (isBadFinale(episodes)) {
    const opts = DEFAULTS.badFinale;
    const avgRating = avg(episodes);
    const finale = episodes[episodes.length - 1].rating;
    const margin = avgRating - finale;
    conf['bad-finale'] = Math.min(1, (margin - opts.belowAvg) / 1.5 + 0.1);
  }

  if (isRollercoaster(episodes)) {
    const opts = DEFAULTS.rollercoaster;
    let flips = 0;
    let prevSign = 0;
    let totalAbs = 0;
    for (let i = 1; i < episodes.length; i++) {
      const diff = episodes[i].rating - episodes[i - 1].rating;
      totalAbs += Math.abs(diff);
      if (Math.abs(diff) < opts.ignoreBelow) continue;
      const sign = diff > 0 ? 1 : -1;
      if (prevSign !== 0 && sign !== prevSign) flips++;
      prevSign = sign;
    }
    const flipMargin = Math.max(0, flips - opts.minFlips) / 6;
    conf.rollercoaster = Math.min(1, flipMargin + 0.1);
  }

  if (isMidPeak(episodes)) {
    const opts = DEFAULTS.midPeak;
    const n = episodes.length;
    let max = -Infinity;
    for (const e of episodes) if (e.rating > max) max = e.rating;
    const start = episodes[0].rating;
    const end = episodes[n - 1].rating;
    const margin = Math.min(max - start - opts.peakAboveStart, max - end - opts.peakAboveEnd);
    conf['mid-peak'] = Math.min(1, margin / 1.5 + 0.1);
  }

  if (isUShaped(episodes)) {
    const opts = DEFAULTS.uShaped;
    const opener = episodes[0].rating;
    const finale = episodes[episodes.length - 1].rating;
    let maxDip = 0;
    for (let i = 1; i < episodes.length - 1; i++) {
      const r = episodes[i].rating;
      const dip = Math.min(opener - r, finale - r);
      if (dip > maxDip) maxDip = dip;
    }
    conf['u-shaped'] = Math.min(1, (maxDip - opts.dipDepth) / 1.5 + 0.1);
  }

  // Clamp all values to [0, 1] and round to 2 decimal places
  for (const k of Object.keys(conf)) {
    conf[k] = Math.round(Math.max(0, Math.min(1, conf[k])) * 100) / 100;
  }
  return conf;
}

// Walk the (series -> season -> episodes) map and return one record per
// season that passes the vote/episode floor. Shape matching is descriptive,
// not gating — seasons with no shape match are still emitted with shapes: []
// so the app can search the full IMDb catalog.
//
// Filters:
//   minEpisodes — skip seasons with fewer rated episodes than this.
//   minVotes    — every episode must have at least this many votes. The
//                 default is intentionally low; the browser UI applies its
//                 own (stricter) vote and popularity filters on top.
function findMatches(seriesById, episodesBySeries, opts = {}) {
  const minEpisodes = opts.minEpisodes ?? 4;
  const minVotes = opts.minVotes ?? 5;

  const seasons = []; // { seriesId, season, eps, shapes, minSeasonVotes }

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
      const confidence = shapeConfidence(eps);
      seasons.push({ seriesId, season, eps, shapes, confidence, minSeasonVotes });
    }
  }

  const matches = [];
  for (const { seriesId, season, eps, shapes, confidence, minSeasonVotes } of seasons) {
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

    // Per-season average runtime, in minutes. Only counts episodes that
    // carry a runtime value (some IMDb entries don't), so a season with
    // one missing episode still gets a useful number.
    let runtimeSum = 0;
    let runtimeCount = 0;
    for (const e of eps) {
      if (e.runtime) { runtimeSum += e.runtime; runtimeCount++; }
    }
    const avgRuntime = runtimeCount > 0 ? Math.round(runtimeSum / runtimeCount) : null;

    const season_obj = {
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
      episodes: eps.map(({ episode, rating, votes, name, runtime }) => {
        const ep = { episode, rating, votes };
        if (name) ep.name = name;
        if (runtime) ep.runtime = runtime;
        return ep;
      }),
      firstRating: ratings[0],
      lastRating: ratings[ratings.length - 1],
      avgRating: Math.round(seasonAvg * 100) / 100,
      minVotes: minSeasonVotes,
      shapes,
      confidence,
    };
    if (avgRuntime !== null) season_obj.avgRuntime = avgRuntime;
    matches.push(season_obj);
  }

  tagSavedBestForLast(matches);
  tagShapeDrift(matches);
  return matches;
}

// Post-pass shape: a series whose highest-numbered season is also the
// highest-avg season earns 'saved-best-for-last' on that final season.
// Requires 3+ seasons in the dataset — a two-season "comeback" is too
// thin to credibly say a show built toward its finale. Ties at the top
// don't qualify: the last season must strictly outscore every other
// season we have for the series.
function tagSavedBestForLast(matches) {
  const bySeries = new Map();
  for (const m of matches) {
    let arr = bySeries.get(m.seriesId);
    if (!arr) { arr = []; bySeries.set(m.seriesId, arr); }
    arr.push(m);
  }
  for (const arr of bySeries.values()) {
    if (arr.length < 3) continue;
    let last = arr[0];
    let topAvg = -Infinity;
    for (const m of arr) {
      if (m.season > last.season) last = m;
      if (m.avgRating > topAvg) topAvg = m.avgRating;
    }
    if (last.avgRating < topAvg) continue;
    const tiedAtTop = arr.filter((m) => m.avgRating === topAvg);
    if (tiedAtTop.length > 1) continue;
    if (!last.shapes.includes('saved-best-for-last')) {
      last.shapes.push('saved-best-for-last');
    }
  }
}

// Cross-season shape drift: for each series with 3+ seasons (sorted by
// season number), tag the LATEST season with 'shape-drift' when either:
//   (a) the show's dominant shape changed from seasons 1..N-1 to season N, OR
//   (b) the avgRating declined by > 0.5 across 2 consecutive seasons at any
//       point, and that trend is still ongoing at the final season.
// A one-sentence driftNote is written onto every season of the series
// describing the trajectory so the modal can surface it.
function tagShapeDrift(matches) {
  const bySeries = new Map();
  for (const m of matches) {
    let arr = bySeries.get(m.seriesId);
    if (!arr) { arr = []; bySeries.set(m.seriesId, arr); }
    arr.push(m);
  }

  for (const arr of bySeries.values()) {
    if (arr.length < 3) continue;
    arr.sort((a, b) => a.season - b.season);

    const last = arr[arr.length - 1];
    const prior = arr.slice(0, arr.length - 1);

    // Dominant shape across prior seasons = shape appearing in the most seasons.
    const shapeCounts = {};
    for (const s of prior) {
      for (const sh of s.shapes) {
        if (sh === 'saved-best-for-last' || sh === 'shape-drift') continue;
        shapeCounts[sh] = (shapeCounts[sh] || 0) + 1;
      }
    }
    const dominantCount = Math.max(0, ...Object.values(shapeCounts));
    // Require dominant shape appeared in strictly more than half the prior
    // seasons — a single season out of two doesn't constitute a "dominant"
    // pattern worth calling a drift.
    const halfPrior = prior.length / 2;
    const dominantShapes = Object.entries(shapeCounts)
      .filter(([, c]) => c > halfPrior && c === dominantCount)
      .map(([s]) => s);

    // Check if the last season lost all dominant prior shapes.
    const lostAll = dominantShapes.length > 0 &&
      dominantShapes.every((s) => !last.shapes.includes(s));

    // Rating decline: does the final season continue a ≥0.5 drop from prev?
    const prev = arr[arr.length - 2];
    const ratingDecline = (prev.avgRating - last.avgRating) >= 0.5;

    if (!lostAll && !ratingDecline) continue;

    // Attach 'shape-drift' to the final season.
    if (!last.shapes.includes('shape-drift')) last.shapes.push('shape-drift');

    // Build a human-readable summary for the modal.
    let note = null;
    if (lostAll && ratingDecline) {
      note = `Dominant ${dominantShapes.join('/')} pattern through S${prior[prior.length - 1].season}, then shape changed and ratings fell in S${last.season}.`;
    } else if (lostAll) {
      note = `${dominantShapes.join('/')} through S${prior[prior.length - 1].season} — shape shifted in S${last.season}.`;
    } else {
      note = `Rating dropped ${(prev.avgRating - last.avgRating).toFixed(1)} pts from S${prev.season} (${prev.avgRating.toFixed(1)}) to S${last.season} (${last.avgRating.toFixed(1)}).`;
    }
    // Write the note onto the drifting season only (not all seasons).
    last.driftNote = note;
  }
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
  isUShaped,
  detectShapes,
  findMatches,
  tagSavedBestForLast,
  tagShapeDrift,
  shapeConfidence,
  // Back-compat with earlier API name.
  isNonDecreasing: isRising,
};
