// THE CALIBRATION GUARD: what a set of scored projections must look like to be
// describing football, stated as bands rather than values.
//
// WHY THIS EXISTS
//
// On 2026-09-16 the planner projected every nailed starter in the league to
// start 64% to 76% of the time, its best player at 3.9 and its best possible
// eleven at 40 points (those eleven scored 51), while 1,200 unit tests were
// green. Every test checked a projection against a hand-built world or against
// the ordering of two players; none compared a league of projections with the
// gameweek that then happened. This module is that comparison, shared by the
// hermetic test over the captured 2026/27 deadlines
// (tests/xp-calibration-guard.test.mjs) and the archive replay
// (scripts/calibration-report.mjs --check).
//
// WHAT A BAND IS. Every check is a ratio or a difference between what was
// projected and what happened, with a tolerance sized from how much that
// measure moves between deadlines, and narrow enough that the shipped model's
// compression falls outside it. No band names a player or a value the current
// model produces: a better model passes them, and a model that projects the
// league flat, or reads its regulars as rotation, or its substitutes as
// likelier to play than its starters, does not. The absolute floors (the
// league's best player, the best eleven) are statements about the scoring
// system, not about any model: a Premier League gameweek has players worth
// five and elevens worth forty-five.
//
// THE NOISE, measured per deadline over 111 replayed deadlines (GW2-38 of
// 2023-24 to 2025-26, production regime, 2026-09-16). The top fifth's
// projected-to-scored ratio moves with a standard deviation of 0.14 between
// deadlines, the top-minus-bottom separation ratio 0.23, the bottom fifth's
// excess 0.22 points, and the ever-present start gap 0.055; the fixed bands
// below sit 2 to 3 of those deviations from a calibrated model for two
// deadlines or more, which is the smallest set anything here is judged on. The
// best eleven's score is the exception: what the projected best eleven then
// scores moves by 17 points from one deadline to the next, a third of the
// total, so its band is a bias test that tightens with the number of
// deadlines, and the projected total itself carries the compression floor.
//
// A ROW is one player's projection for one gameweek he has a fixture in:
//   { position, fixtures, xPoints, pStart, pAppear, points, started, appeared,
//     everPresent, clubMatches }
// `everPresent` means he started every club match so far this season, read off
// the payload's own current-season totals; `points`/`started`/`appeared` are
// what that gameweek actually produced.

export const CALIBRATION_BANDS = Object.freeze({
  // Players who have started every match: the start probability must match how
  // often they started, and they must not be read as unlikely to play.
  everPresentStartGap: 0.08,
  everPresentAppearShortfall: 0.08,
  everPresentPointsRatio: [0.8, 1.25],
  // Start probability calibrated in every bucket that holds enough players to
  // measure. The buckets are what "expected-start bucket" means in the audit.
  startBucketEdges: [0, 0.25, 0.5, 0.75, 0.9, 1.0000001],
  startBucketMinPlayers: 30,
  startBucketGap: 0.15,
  // Compression: the projected gap between the top and bottom fifth of the
  // league must be most of the gap they then scored.
  quintileSeparationRatio: [0.7, 1.4],
  topQuintileRatio: [0.75, 1.3],
  bottomQuintileExcess: 0.35,
  // The shape of the likely starters' projections.
  likelyStarterSpread: 0.8,
  topOfLeagueOverMedian: 1.6,
  topOfLeagueFloor: 5,
  // The best eleven by projection, no budget: projected inside a football
  // range, and its mean error inside 2.5 standard errors of the per-deadline
  // noise.
  bestElevenRange: [45, 80],
  bestElevenDeadlineSd: 17,
  bestElevenZ: 2.5,
  // A projection pool below this is not a league.
  minRowsPerDeadline: 200,
});

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const quantile = (sorted, q) => sorted[Math.floor(q * (sorted.length - 1))];

/** The best eleven by projection with no budget, and what those eleven scored. */
export function bestEleven(rows) {
  const byPos = { 1: [], 2: [], 3: [], 4: [] };
  for (const r of rows) if (byPos[r.position]) byPos[r.position].push(r);
  for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.xPoints - a.xPoints);
  let best = null;
  for (let d = 3; d <= 5; d++) {
    for (let m = 2; m <= 5; m++) {
      const f = 10 - d - m;
      if (f < 1 || f > 3) continue;
      const xi = [...byPos[1].slice(0, 1), ...byPos[2].slice(0, d), ...byPos[3].slice(0, m), ...byPos[4].slice(0, f)];
      if (xi.length !== 11) continue;
      const projected = xi.reduce((s, r) => s + r.xPoints, 0);
      if (!best || projected > best.projected) {
        best = { projected, actual: xi.reduce((s, r) => s + r.points, 0), formation: `${d}-${m}-${f}` };
      }
    }
  }
  return best;
}

const group = (rows) => ({
  n: rows.length,
  pStart: mean(rows.map((r) => r.pStart)),
  started: mean(rows.map((r) => r.started)),
  pAppear: mean(rows.map((r) => r.pAppear)),
  appeared: mean(rows.map((r) => r.appeared)),
  xPoints: mean(rows.map((r) => r.xPoints)),
  points: mean(rows.map((r) => r.points)),
});

/**
 * The facts the bands are checked against, over one or more deadlines. Groups
 * of players (ever-present, start buckets) are pooled across the deadlines;
 * per-deadline shapes (quintiles, spread, best eleven) are taken per deadline
 * and averaged, because a fifth of the league is a fifth of ONE gameweek's
 * league.
 *
 * @param {Array<Array<object>>} deadlines  one row array per deadline
 */
export function calibrationFacts(deadlines, bands = CALIBRATION_BANDS) {
  const single = [];
  const perDeadline = [];
  let startAboveAppear = 0;
  for (const rows of deadlines) {
    for (const r of rows) {
      if (r.pStart > r.pAppear + 1e-9) startAboveAppear++;
      if (r.fixtures === 1) single.push(r);
    }
    const pool = rows.filter((r) => r.fixtures >= 1 && r.xPoints > 0.5).sort((a, b) => a.xPoints - b.xPoints);
    const fifth = Math.floor(pool.length / 5);
    const likely = rows.filter((r) => r.fixtures >= 1 && r.pStart > 0.5).map((r) => r.xPoints).sort((a, b) => a - b);
    const xi = bestEleven(rows.filter((r) => r.fixtures >= 1));
    perDeadline.push({
      rows: rows.length,
      top: group(pool.slice(pool.length - fifth)),
      bottom: group(pool.slice(0, fifth)),
      likely: likely.length ? {
        n: likely.length, p10: quantile(likely, 0.1), median: quantile(likely, 0.5),
        p90: quantile(likely, 0.9), max: likely[likely.length - 1],
      } : null,
      bestEleven: xi,
    });
  }
  const avg = (pick) => mean(perDeadline.map(pick).filter(Number.isFinite));
  const edges = bands.startBucketEdges;
  const startBuckets = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const inBucket = single.filter((r) => r.pStart >= edges[i] && r.pStart < edges[i + 1] && r.clubMatches >= 1);
    startBuckets.push({ from: edges[i], to: Math.min(1, edges[i + 1]), ...group(inBucket) });
  }
  return {
    deadlines: perDeadline.length,
    minRows: Math.min(...perDeadline.map((d) => d.rows)),
    startAboveAppear,
    everPresent: group(single.filter((r) => r.everPresent && r.clubMatches >= 2)),
    startBuckets,
    top: { xPoints: avg((d) => d.top.xPoints), points: avg((d) => d.top.points) },
    bottom: { xPoints: avg((d) => d.bottom.xPoints), points: avg((d) => d.bottom.points) },
    likely: {
      p10: avg((d) => d.likely && d.likely.p10),
      median: avg((d) => d.likely && d.likely.median),
      p90: avg((d) => d.likely && d.likely.p90),
      max: avg((d) => d.likely && d.likely.max),
    },
    bestEleven: { projected: avg((d) => d.bestEleven && d.bestEleven.projected), actual: avg((d) => d.bestEleven && d.bestEleven.actual) },
    perDeadline,
  };
}

const outside = (v, [lo, hi]) => !(v >= lo && v <= hi);
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

/**
 * Every band the facts break, as `{ code, message }`. Empty means calibrated.
 */
export function calibrationViolations(facts, bands = CALIBRATION_BANDS) {
  const out = [];
  const fail = (code, message) => out.push({ code, message });

  if (facts.minRows < bands.minRowsPerDeadline) {
    fail('pool_too_small', `a deadline projected ${facts.minRows} players, fewer than a league`);
  }
  if (facts.startAboveAppear > 0) {
    fail('start_exceeds_appear', `${facts.startAboveAppear} projections start a player more often than he plays`);
  }

  const e = facts.everPresent;
  if (e.n > 0) {
    if (Math.abs(e.pStart - e.started) > bands.everPresentStartGap) {
      fail('ever_present_start', `ever-present starters: mean start probability ${f2(e.pStart)}, started ${f2(e.started)} (n=${e.n})`);
    }
    if (e.pAppear < e.appeared - bands.everPresentAppearShortfall) {
      fail('ever_present_appear', `ever-present starters: mean appearance probability ${f2(e.pAppear)}, appeared ${f2(e.appeared)}`);
    }
    if (outside(e.xPoints / e.points, bands.everPresentPointsRatio)) {
      fail('ever_present_points', `ever-present starters: projected ${f2(e.xPoints)}, scored ${f2(e.points)}`);
    }
  }

  for (const b of facts.startBuckets) {
    if (b.n < bands.startBucketMinPlayers) continue;
    if (Math.abs(b.pStart - b.started) > bands.startBucketGap) {
      fail('start_bucket', `start probability ${f2(b.from)}-${f2(b.to)}: mean ${f2(b.pStart)}, started ${f2(b.started)} (n=${b.n})`);
    }
  }

  const projectedGap = facts.top.xPoints - facts.bottom.xPoints;
  const actualGap = facts.top.points - facts.bottom.points;
  if (outside(projectedGap / actualGap, bands.quintileSeparationRatio)) {
    fail('quintile_separation', `top fifth minus bottom fifth: projected ${f2(projectedGap)}, scored ${f2(actualGap)}`);
  }
  if (outside(facts.top.xPoints / facts.top.points, bands.topQuintileRatio)) {
    fail('top_quintile', `top fifth by projection: projected ${f2(facts.top.xPoints)}, scored ${f2(facts.top.points)}`);
  }
  if (facts.bottom.xPoints - facts.bottom.points > bands.bottomQuintileExcess) {
    fail('bottom_quintile', `bottom fifth by projection: projected ${f2(facts.bottom.xPoints)}, scored ${f2(facts.bottom.points)}`);
  }

  const l = facts.likely;
  if (l.p90 - l.median < bands.likelyStarterSpread) {
    fail('spread', `likely starters: 90th percentile ${f2(l.p90)} against a median of ${f2(l.median)}`);
  }
  if (l.max < bands.topOfLeagueOverMedian * l.median || l.max < bands.topOfLeagueFloor) {
    fail('top_of_league', `the best projection in the league is ${f2(l.max)} against a median likely starter of ${f2(l.median)}`);
  }

  const xi = facts.bestEleven;
  const xiTolerance = (bands.bestElevenZ * bands.bestElevenDeadlineSd) / Math.sqrt(Math.max(1, facts.deadlines));
  if (outside(xi.projected, bands.bestElevenRange)) {
    fail('best_eleven', `the best eleven by projection projects ${f2(xi.projected)}, outside `
      + `${bands.bestElevenRange[0]}-${bands.bestElevenRange[1]} (it scored ${f2(xi.actual)})`);
  } else if (Math.abs(xi.projected - xi.actual) > xiTolerance) {
    fail('best_eleven', `the best eleven by projection projects ${f2(xi.projected)} and scored ${f2(xi.actual)}, `
      + `a miss beyond the ${f2(xiTolerance)} that ${facts.deadlines} deadline${facts.deadlines === 1 ? '' : 's'} of noise explain`);
  }
  return out;
}
