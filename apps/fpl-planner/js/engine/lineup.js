// The starting eleven and the bench order.
//
// Sorting fifteen players by expected points and taking the top eleven produces
// an illegal team most weeks, so the eleven is chosen by ENUMERATING every legal
// formation the rules allow and taking the best players for each. The formation
// list is generated from `rules.positions` min/max play counts, never written
// down, so a rules change upstream changes the search space automatically.
//
// WHY THE SELECTION SCORE IS NOT EXPECTED POINTS
//
// Expected points alone will start a player who is a coin flip to be in the
// team ahead of a nailed one worth marginally less, and it will do it every
// week. Two things are missing from the mean:
//
//   1. MINUTES RISK. A starter who does not play forfeits an auto-substitution
//      slot, and there are only three of them. What comes on is a bench player,
//      who is by construction the worst of the fifteen. That residual loss is
//      not in the mean, because the mean already assumes the zero.
//   2. UNCERTAINTY. Two players with the same mean and very different spreads
//      are not the same pick for a manager who is not chasing rank this week.
//      The armband is where variance is bought (see captain.js), not the eleven.
//
// So each player carries a selection score
//
//   score = xPoints - riskAversion * sd - minutesRiskWeight * (1 - pAppear)
//
// and both weights are named parameters, exposed on LINEUP_PARAMS and
// switchable by risk profile.
//
// WHAT IS ACTUALLY MAXIMIZED, AND WHY THE OBVIOUS SHORTCUT IS WRONG
//
// The objective is the sum of the eleven's scores PLUS what the bench is
// expected to recover through auto-substitutions. That total is NOT separable
// across players, because benching a player changes what the bench can cover.
// The clearest case is the goalkeeper: two keepers worth the same expected
// points, one nailed and one a coin flip, are not interchangeable. Starting the
// coin flip and keeping the nailed keeper in reserve is worth strictly more,
// because the reserve plays whenever the starter does not, and no separable
// score can see that.
//
// So "take the best n at each position within each formation" is a shortcut,
// not the optimum, and mode 'exact' does not take it: it enumerates EVERY legal
// eleven (every formation crossed with every way of choosing that formation's
// starters out of the squad) and evaluates the real objective on each. With
// FPL's current rules that is 550 elevens per gameweek.
//
// mode 'fast' keeps the shortcut, and is documented as an approximation where
// it is used: it is the inner loop of the transfer search and the squad
// builder, which rank thousands of squads and would be an order of magnitude
// slower on the exact path.
//
// WHY THE BENCH IS WORTH REAL POINTS
//
// FPL substitutes a player who plays zero minutes with the first bench player
// who did play AND whose introduction leaves the formation legal. A bench
// goalkeeper only ever replaces the goalkeeper. A three-at-the-back eleven
// cannot bring a midfielder on for its missing defender, because the resulting
// eleven would have two defenders. So bench ORDER is worth points, and it is
// worth different points depending on the formation, which is why the formation
// is chosen on the total of eleven plus expected auto-substitution value rather
// than on the eleven alone.
//
// The auto-substitution value is computed exactly under one stated assumption:
// that non-appearances are independent across players. Absences are counted per
// position with a Poisson-binomial dynamic program, bench availability is
// enumerated over all subsets, and FPL's substitution procedure is simulated in
// each scenario. Nothing here is a fitted fudge factor.

import {
  fixedCountPositionIds,
  outfieldPositionIds,
  benchOutfieldSlots,
  formationOf,
} from './validate.js';
import { chooseCaptain } from './captain.js';

// Risk profiles. `riskAversion` is a points penalty per point of standard
// deviation; `minutesRiskWeight` is a points penalty per unit of non-appearance
// probability, representing the auto-substitution slot a doubtful starter
// consumes and the bench quality gap that follows.
const RISK_PROFILES = {
  conservative: { riskAversion: 0.12, minutesRiskWeight: 0.60 },
  balanced: { riskAversion: 0.05, minutesRiskWeight: 0.35 },
  aggressive: { riskAversion: 0.00, minutesRiskWeight: 0.20 },
};

// Per-gameweek discount for horizon valuation. Points five weeks out are real
// but the squad, the fixtures and the injury list between here and there are
// not, so later gameweeks carry less weight in a squad-level comparison.
const DEFAULT_DISCOUNT = 0.9;

// Kept equal to planner.js DEFAULT_HORIZON, which carries the measurement that
// chose the number. transfers.js and squad-builder.js both fall back to this
// one, so a mismatch would score a candidate over a different number of
// gameweeks than the plan it ends up in. `tests/lineup.test.mjs` asserts the
// equality rather than the literal, so the two cannot drift apart again.
const DEFAULT_HORIZON = 5;

// Scenario probabilities below this contribute less than a thousandth of a
// point and only cost time.
const PROB_EPS = 1e-7;

// In fast mode only the best few formations by separable score have their bench
// evaluated. The bench is worth a fraction of a point, so a formation three or
// more points behind on the eleven cannot win on it, and the transfer search
// runs thousands of these.
const FAST_FORMATION_CHECK = 3;

export const LINEUP_PARAMS = Object.freeze({
  riskProfiles: RISK_PROFILES,
  defaultDiscount: DEFAULT_DISCOUNT,
  defaultHorizon: DEFAULT_HORIZON,
  fastFormationCheck: FAST_FORMATION_CHECK,
});

// ---------------------------------------------------------------------------

function resolveParams(opts) {
  const profile = RISK_PROFILES[opts.risk] || RISK_PROFILES.balanced;
  return {
    riskAversion: opts.riskAversion ?? profile.riskAversion,
    minutesRiskWeight: opts.minutesRiskWeight ?? profile.minutesRiskWeight,
  };
}

// Positions are not carried on a projection, so the caller supplies the lookup:
// `opts.gameState` (the normal case, every caller has one) or an explicit
// `opts.positionOf` function for tests and synthetic worlds.
function resolvePositionOf(opts) {
  if (typeof opts.positionOf === 'function') return opts.positionOf;
  if (opts.gameState && opts.gameState.players) {
    const players = opts.gameState.players;
    return (id) => {
      const p = players.get(id);
      return p ? p.position : null;
    };
  }
  throw new Error('optimizeLineup needs opts.gameState or opts.positionOf to resolve player positions.');
}

// Every legal formation, generated from the rules. With FPL's current
// element_types this yields the eight shapes managers know (3-4-3, 3-5-2,
// 4-3-3, 4-4-2, 4-5-1, 5-2-3, 5-3-2, 5-4-1), but none of them is written down.
export function legalFormations(rules, availableCounts) {
  const ids = Object.values(rules.positions).map(p => p.id).sort((a, b) => a - b);
  const out = [];
  const current = new Map();

  const recurse = (i, remaining) => {
    if (i === ids.length) {
      if (remaining === 0) out.push(new Map(current));
      return;
    }
    const pos = rules.positions[ids[i]];
    const available = availableCounts.get(ids[i]) || 0;
    const max = Math.min(pos.maxPlay, available, remaining);
    for (let n = pos.minPlay; n <= max; n++) {
      current.set(ids[i], n);
      recurse(i + 1, remaining - n);
    }
    current.delete(ids[i]);
  };

  recurse(0, rules.starters);
  return out;
}

function buildRows(squadPlayerIds, projections, gw, positionOf, params) {
  const rows = [];
  for (const id of squadPlayerIds) {
    const proj = projections.get(id, gw);
    const xPoints = proj ? proj.xPoints : 0;
    const pAppear = proj ? proj.pAppear : 0;
    const sd = proj ? proj.sd : 0;
    rows.push({
      id,
      position: positionOf(id),
      xPoints,
      pAppear,
      sd,
      ceiling: proj ? proj.ceiling : 0,
      // Points the player is worth GIVEN he plays, which is what an
      // auto-substitution actually delivers.
      condPoints: pAppear > 0 ? xPoints / pAppear : 0,
      score: xPoints - params.riskAversion * sd - params.minutesRiskWeight * (1 - pAppear),
    });
  }
  return rows;
}

// Deterministic ordering: best score first, expected points as the tie-break,
// then player id so two identical projections never reorder between runs.
function compareRows(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.xPoints !== a.xPoints) return b.xPoints - a.xPoints;
  return a.id - b.id;
}

// ---------------------------------------------------------------------------
// Auto-substitution model
// ---------------------------------------------------------------------------

// Poisson-binomial distribution of the number of absences among a set of
// starters, truncated at `cap` because only `cap` substitutions can ever be
// made and the tail beyond it changes nothing.
function absenceDistribution(rows, cap) {
  const dist = new Array(cap + 1).fill(0);
  dist[0] = 1;
  for (const r of rows) {
    const q = r.pAppear < 0 ? 1 : r.pAppear > 1 ? 0 : 1 - r.pAppear;
    for (let k = cap; k >= 0; k--) {
      const p = dist[k];
      if (p === 0) continue;
      dist[k] = p * (1 - q);
      const up = Math.min(k + 1, cap);
      dist[up] += p * q;
    }
  }
  return dist;
}

// FPL's substitution procedure for one fully specified scenario: which
// positions are short, and which bench players turned out to play.
//
// Each bench player in turn replaces an absent starter if that leaves a legal
// formation. Replacing a player of his own position is always legal and is
// tried first; otherwise the position with the most absences that can spare a
// slot wins, which is the assignment that lets the most later substitutions
// still happen.
function simulateSubs(order, playMask, absent, counts, minPlay, maxPlay, posIndex) {
  const n = order.length;
  const m = absent.length;
  let remaining = 0;
  for (let i = 0; i < m; i++) remaining += absent[i];
  if (remaining === 0) return 0;

  const a = absent.slice();
  const c = counts.slice();
  let recovered = 0;

  for (let j = 0; j < n && remaining > 0; j++) {
    if (((playMask >> j) & 1) === 0) continue;
    const b = order[j];
    const qi = posIndex.get(b.position);
    let chosen = -1;
    if (a[qi] > 0) {
      chosen = qi;
    } else if (c[qi] + 1 <= maxPlay[qi]) {
      let bestAbs = 0;
      for (let ri = 0; ri < m; ri++) {
        if (a[ri] <= 0) continue;
        if (c[ri] - 1 < minPlay[ri]) continue;
        if (a[ri] > bestAbs) {
          bestAbs = a[ri];
          chosen = ri;
        }
      }
    }
    if (chosen < 0) continue;
    a[chosen] -= 1;
    remaining -= 1;
    if (chosen !== qi) {
      c[chosen] -= 1;
      c[qi] += 1;
    }
    recovered += b.condPoints;
  }
  return recovered;
}

function expectedRecovery(order, dists, counts, minPlay, maxPlay, posIndex, caps) {
  const n = order.length;
  const combos = 1 << n;
  const comboProb = new Array(combos);
  for (let mask = 0; mask < combos; mask++) {
    let p = 1;
    for (let j = 0; j < n; j++) {
      const pa = order[j].pAppear;
      p *= ((mask >> j) & 1) ? pa : 1 - pa;
    }
    comboProb[mask] = p;
  }

  const m = caps.length;
  const idx = new Array(m).fill(0);
  let total = 0;

  for (;;) {
    let pAbs = 1;
    for (let i = 0; i < m; i++) pAbs *= dists[i][idx[i]];
    if (pAbs > PROB_EPS) {
      let any = 0;
      for (let i = 0; i < m; i++) any += idx[i];
      if (any > 0) {
        for (let mask = 1; mask < combos; mask++) {
          const pc = comboProb[mask];
          if (pc <= PROB_EPS) continue;
          const rec = simulateSubs(order, mask, idx, counts, minPlay, maxPlay, posIndex);
          if (rec > 0) total += pAbs * pc * rec;
        }
      }
    }
    let i = 0;
    for (; i < m; i++) {
      idx[i] += 1;
      if (idx[i] <= caps[i]) break;
      idx[i] = 0;
    }
    if (i === m) break;
  }

  return total;
}

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

// Best bench order for a given eleven, plus what that bench is worth.
export function orderBench(xiRows, benchRows, rules, { exact = true } = {}) {
  const fixed = new Set(fixedCountPositionIds(rules));
  const outfield = outfieldPositionIds(rules);
  const posIndex = new Map(outfield.map((id, i) => [id, i]));

  const benchFixed = benchRows.filter(r => fixed.has(r.position)).sort(compareRows);
  const benchOutfield = benchRows.filter(r => !fixed.has(r.position));

  // The reserve keeper covers exactly one starter and nothing else, so his
  // value does not depend on the outfield order.
  const startingFixed = xiRows.filter(r => fixed.has(r.position));
  const gkRow = benchFixed[0] || null;
  const gkValue = gkRow && startingFixed.length
    ? (1 - startingFixed[0].pAppear) * gkRow.pAppear * gkRow.condPoints
    : 0;

  const benchXPoints = benchRows.reduce((s, r) => s + r.xPoints, 0);

  if (!benchOutfield.length) {
    return { gk: gkRow ? gkRow.id : null, order: [], autosubValue: gkValue, benchXPoints, gkValue };
  }

  const cap = benchOutfield.length;

  // FAST MODE. The exact model below simulates FPL's substitution procedure in
  // every scenario, which is what makes it expensive. Fast mode keeps the same
  // probability model but drops the one thing that needs the simulation: it
  // does not check that the substitution leaves a LEGAL formation, so it treats
  // every open slot as fillable.
  //
  // Everything else is real. A bench player comes on when he plays and a slot
  // is still open, and a slot is open when more starters are missing than the
  // players ahead of him in the order who turned up. So the absence count is
  // convolved with how many earlier substitutes actually played, rather than
  // multiplied by a fixed per-slot constant. Against the exact model over 3000
  // randomized squads that is a mean error of +0.02 points with an RMSE of
  // 0.10, and exactly zero when the eleven cannot lose anybody. The fixed
  // constants it replaces were out by -1.01 on the same squads and by +0.73 on
  // an eleven where no substitution was possible at all, in opposite
  // directions, which is noise the transfer search then ranks squads on.
  if (!exact) {
    const order = benchOutfield.slice().sort((a, b) => {
      const va = a.pAppear * a.condPoints;
      const vb = b.pAppear * b.condPoints;
      if (vb !== va) return vb - va;
      return a.id - b.id;
    });
    const absences = absenceDistribution(xiRows.filter(r => !fixed.has(r.position)), cap);
    let value = gkValue;
    let ahead = [1];
    for (let j = 0; j < order.length; j++) {
      let pSlotOpen = 0;
      for (let k = 0; k < ahead.length; k++) {
        if (ahead[k] === 0) continue;
        let moreAbsent = 0;
        for (let m = k + 1; m < absences.length; m++) moreAbsent += absences[m];
        pSlotOpen += ahead[k] * moreAbsent;
      }
      value += pSlotOpen * order[j].pAppear * order[j].condPoints;
      const next = new Array(ahead.length + 1).fill(0);
      for (let k = 0; k < ahead.length; k++) {
        next[k] += ahead[k] * (1 - order[j].pAppear);
        next[k + 1] += ahead[k] * order[j].pAppear;
      }
      ahead = next;
    }
    return { gk: gkRow ? gkRow.id : null, order: order.map(r => r.id), autosubValue: value, benchXPoints, gkValue };
  }

  const counts = outfield.map(pos => xiRows.reduce((n, r) => n + (r.position === pos ? 1 : 0), 0));
  const minPlay = outfield.map(pos => rules.positions[pos].minPlay);
  const maxPlay = outfield.map(pos => rules.positions[pos].maxPlay);
  const dists = outfield.map(pos => absenceDistribution(xiRows.filter(r => r.position === pos), cap));
  const caps = dists.map(d => d.length - 1);

  let best = null;
  for (const order of permutations(benchOutfield)) {
    const value = expectedRecovery(order, dists, counts, minPlay, maxPlay, posIndex, caps);
    if (best === null || value > best.value + 1e-12
      || (Math.abs(value - best.value) <= 1e-12 && lexLower(order, best.order))) {
      best = { value, order };
    }
  }

  return {
    gk: gkRow ? gkRow.id : null,
    order: best.order.map(r => r.id),
    autosubValue: gkValue + best.value,
    benchXPoints,
    gkValue,
  };
}

// ---------------------------------------------------------------------------
// Enumerating every legal eleven
// ---------------------------------------------------------------------------

// Which n of m players start, as index lists in ascending order so the
// best-scoring selection (0, 1, ... n-1 against a score-sorted list) always
// comes first. Cached because the shape of the choice repeats for every squad,
// every gameweek and every candidate the transfer search finalizes.
const COMBINATION_CACHE = new Map();

function indexCombinations(m, n) {
  const key = `${m}:${n}`;
  const cached = COMBINATION_CACHE.get(key);
  if (cached) return cached;
  const out = [];
  const current = [];
  const walk = (start) => {
    if (current.length === n) {
      out.push(current.slice());
      return;
    }
    for (let i = start; i < m; i++) {
      current.push(i);
      walk(i + 1);
      current.pop();
    }
  };
  walk(0);
  COMBINATION_CACHE.set(key, out);
  return out;
}

// Every way of filling a formation from this squad, with the players left over
// as the bench. `visit` receives fresh arrays, so it may keep them.
function forEachEleven(formation, byPosition, visit) {
  const groups = [...byPosition].map(([pos, list]) => ({
    list,
    combos: indexCombinations(list.length, formation.get(pos) || 0),
  }));
  const picks = new Array(groups.length);

  const walk = (g) => {
    if (g === groups.length) {
      const xiRows = [];
      const benchRows = [];
      let score = 0;
      let points = 0;
      let variance = 0;
      for (let i = 0; i < groups.length; i++) {
        const { list } = groups[i];
        const combo = picks[i];
        let c = 0;
        for (let j = 0; j < list.length; j++) {
          if (c < combo.length && combo[c] === j) {
            const row = list[j];
            xiRows.push(row);
            score += row.score;
            points += row.xPoints;
            variance += row.sd * row.sd;
            c++;
          } else {
            benchRows.push(list[j]);
          }
        }
      }
      visit(xiRows, benchRows, score, points, variance);
      return;
    }
    for (const combo of groups[g].combos) {
      picks[g] = combo;
      walk(g + 1);
    }
  };

  walk(0);
}

// The most any bench of this squad could ever recover, whatever the eleven.
// Elevens further behind the incumbent than this cannot win, so they are never
// benched-and-scored. The bound has to be genuine or the search stops being
// exact, so both halves are deliberately generous:
//
//   FIXED-COUNT POSITIONS (the reserve keeper) cover exactly one starter, and
//   the reserve is worth pAppear * conditional points when he does, so the term
//   is at most the largest (1 - pAppear of any starter) * (that product) over
//   ordered pairs in the position.
//
//   OUTFIELD substitutions are bounded two ways, and the smaller wins. Each
//   one recovers the conditional points of whoever comes on, at most
//   `maxCond`, and there can never be more of them than there are absences or
//   bench slots. Separately, a bench player cannot come on more than once and
//   cannot come on at all when he is not playing, so the whole bench is worth
//   at most the largest pAppear * conditional points its slots could hold. The
//   first bound is tight for a nailed squad, the second for a squad where
//   nobody is certain to play, which are the two ends of the search.
function autosubCeiling(rows, byPosition, rules) {
  const fixed = new Set(fixedCountPositionIds(rules));

  let fixedTerm = 0;
  for (const posId of fixed) {
    const list = byPosition.get(posId) || [];
    let worstAppear = 0;
    let bestReserve = 0;
    for (const r of list) {
      worstAppear = Math.max(worstAppear, 1 - r.pAppear);
      bestReserve = Math.max(bestReserve, r.pAppear * r.condPoints);
    }
    fixedTerm += worstAppear * bestReserve;
  }

  const outfield = rows.filter(r => !fixed.has(r.position));
  if (!outfield.length) return fixedTerm;

  const slots = benchOutfieldSlots(rules);
  const maxCond = outfield.reduce((m, r) => Math.max(m, r.condPoints), 0);
  const fixedStarters = [...fixed].reduce((n, posId) => n + rules.positions[posId].minPlay, 0);
  const outfieldStarters = rules.starters - fixedStarters;
  const absences = outfield
    .map(r => 1 - r.pAppear)
    .sort((a, b) => b - a)
    .slice(0, outfieldStarters)
    .reduce((s, a) => s + a, 0);
  const richestBench = outfield
    .map(r => r.pAppear * r.condPoints)
    .sort((a, b) => b - a)
    .slice(0, slots)
    .reduce((s, v) => s + v, 0);

  return fixedTerm + Math.min(maxCond * Math.min(slots, absences), richestBench);
}

// Deterministic tie-break between two equally valuable bench orders.
function lexLower(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return a[i].id < b[i].id;
  }
  return false;
}

// ---------------------------------------------------------------------------

export function optimizeLineup(squadPlayerIds, projections, gw, rules, opts = {}) {
  const params = resolveParams(opts);
  const positionOf = resolvePositionOf(opts);
  const exact = opts.mode !== 'fast';

  const rows = buildRows(squadPlayerIds, projections, gw, positionOf, params);
  const byPosition = new Map();
  for (const r of rows) {
    if (!byPosition.has(r.position)) byPosition.set(r.position, []);
    byPosition.get(r.position).push(r);
  }
  for (const list of byPosition.values()) list.sort(compareRows);

  const availableCounts = new Map([...byPosition].map(([pos, list]) => [pos, list.length]));
  const formations = legalFormations(rules, availableCounts);
  if (!formations.length) {
    throw new Error('No legal formation can be built from this squad: it does not hold enough players in some position.');
  }

  // Prefix sums make the separable part of every formation an O(1) lookup.
  const prefix = new Map();
  for (const [pos, list] of byPosition) {
    const score = [0];
    const points = [0];
    const variance = [0];
    for (let i = 0; i < list.length; i++) {
      score.push(score[i] + list[i].score);
      points.push(points[i] + list[i].xPoints);
      variance.push(variance[i] + list[i].sd * list[i].sd);
    }
    prefix.set(pos, { score, points, variance });
  }

  const scored = formations.map(formation => {
    let score = 0;
    let points = 0;
    let variance = 0;
    for (const [pos, n] of formation) {
      const pre = prefix.get(pos);
      score += pre.score[n];
      points += pre.points[n];
      variance += pre.variance[n];
    }
    return { formation, score, points, variance };
  });
  scored.sort((a, b) => b.score - a.score);

  let best = null;
  const consider = (formation, xiRows, benchRows, score, points, variance) => {
    const bench = orderBench(xiRows, benchRows, rules, { exact });
    const total = score + bench.autosubValue;
    if (best === null || total > best.total + 1e-12) {
      best = { total, score, points, variance, xiRows, bench, formation };
    }
  };

  if (exact) {
    // Every legal eleven, best-scoring formation first and, inside a formation,
    // the best-scoring selection first. That order makes the incumbent strong
    // immediately, which is what gives the ceiling below something to prune
    // against, and it means an eleven only displaces the shortcut answer when
    // it is STRICTLY better on the real objective.
    const ceiling = autosubCeiling(rows, byPosition, rules);
    for (const { formation, score: bestPossible } of scored) {
      if (best !== null && bestPossible + ceiling <= best.total) continue;
      forEachEleven(formation, byPosition, (xiRows, benchRows, score, points, variance) => {
        // No bench can be worth more than the ceiling, so an eleven this far
        // behind on the separable score cannot win however it is benched.
        if (best !== null && score + ceiling <= best.total) return;
        consider(formation, xiRows, benchRows, score, points, variance);
      });
    }
  } else {
    for (const { formation, score, points, variance } of scored.slice(0, FAST_FORMATION_CHECK)) {
      const xiRows = [];
      const benchRows = [];
      for (const [pos, list] of byPosition) {
        const n = formation.get(pos) || 0;
        for (let i = 0; i < list.length; i++) {
          (i < n ? xiRows : benchRows).push(list[i]);
        }
      }
      consider(formation, xiRows, benchRows, score, points, variance);
    }
  }

  // Contract ordering: goalkeeper first, then each outfield position in id
  // order, best first inside each.
  const startingXI = best.xiRows
    .slice()
    .sort((a, b) => (a.position !== b.position ? a.position - b.position : compareRows(a, b)))
    .map(r => r.id);

  return {
    startingXI,
    formation: formationOf(startingXI, positionOf, rules),
    bench: { gk: best.bench.gk, order: best.bench.order },
    xPoints: best.points,
    sd: Math.sqrt(Math.max(0, best.variance)),
    benchXPoints: best.bench.benchXPoints,
    autosubValue: best.bench.autosubValue,
    xPointsWithAutosubs: best.points + best.bench.autosubValue,
    selectionScore: best.score,
    formationsEvaluated: formations.length,
  };
}

// ---------------------------------------------------------------------------
// Squad-level value over a horizon
//
// TWO FUNCTIONS LIVE BELOW AND THEY ARE NOT THE SAME NUMBER. Read this before
// using either.
//
// `squadObjective` is THE OBJECTIVE. It is what the app reports for a squad
// everywhere a manager can read it: the hero card's xP, the chip evaluator's
// comparison, the explanation layer, and the "why not this player" answer. It
// is `squadTrajectory` from chips.js, recomputed here so that the squad builder
// can optimize it without importing chips.js (which imports the builder). The
// two are asserted equal to the last bit in tests/optimizer-consistency.test.mjs
// and must never be allowed to drift.
//
// `squadHorizonValue` is a PROXY, kept for the transfer search's shortlist. It
// differs from the objective in two ways and both were deliberate once:
//
//   it ADDS the auto-substitution value of the bench, which the reported number
//     does not contain, and
//   it captains the highest projected starter, where the app's armband comes
//     from captain.js and is a certainty-equivalent choice that often differs.
//
// A squad ranked on the proxy is therefore not the squad that maximizes the
// number the app prints. That is tolerable in transfers.js, where the proxy
// only shortlists and planner.js re-scores every survivor on `squadTrajectory`
// before choosing. It was NOT tolerable in squad-builder.js, whose answer was
// final: the builder returned the proxy's optimum and the counterfactual then
// reported the objective, so a squad with a forced-in player could and did read
// higher than the app's own recommendation. See
// experiments/optimizer-self-consistency.md.
//
// Anything whose output is shown to a manager, or compared against something
// shown to a manager, must end on `squadObjective`.
// ---------------------------------------------------------------------------

// The objective of record: for each gameweek in the horizon, the best legal
// eleven's expected points plus the armband, discounted. Bit-identical to
// chips.js `squadTrajectory().total`.
//
// The bench does not appear. That is a property of the number the app reports,
// not an oversight here: `optimizeLineup` still values auto-substitutions when
// it picks WHICH eleven starts, so bench order and bench cover are still chosen
// on their real worth. What the horizon total does not do is pay a manager for
// points his bench might recover, because the hero card does not either.
export function squadObjective(squadIds, projections, gw, rules, opts = {}) {
  const horizon = opts.horizon ?? DEFAULT_HORIZON;
  const discount = opts.discount ?? DEFAULT_DISCOUNT;
  const lineupOpts = { ...opts, mode: opts.mode || 'fast' };
  // squadTrajectory walks the full horizon whatever the projections cover; a
  // gameweek past `gwTo` has no rows, so every player scores zero and the
  // gameweek contributes zero to the total. Stopping here instead is the same
  // number for less work, and the equality test covers the case.
  const last = Math.min(gw + horizon - 1, projections.gwTo);

  // The armband is 60% of the cost of this function and it depends only on the
  // eleven, the gameweek and the risk profile. A search that ranks ten thousand
  // squads re-picks the same eleven thousands of times, so a caller running one
  // may hand in a Map to remember them in. It is the caller's Map and the
  // caller's lifetime; nothing here holds one between calls.
  const cache = opts.armbandCache || null;

  let total = 0;
  const byGw = [];
  for (let g = gw, k = 0; g <= last; g++, k++) {
    const lineup = optimizeLineup(squadIds, projections, g, rules, lineupOpts);
    let armband;
    if (cache) {
      const key = `${g}|${lineup.startingXI.slice().sort((a, b) => a - b).join(',')}`;
      armband = cache.get(key);
      if (armband === undefined) {
        armband = chooseCaptain(lineup.startingXI, projections, g, opts.gameState, opts);
        cache.set(key, armband);
      }
    } else {
      armband = chooseCaptain(lineup.startingXI, projections, g, opts.gameState, opts);
    }
    const captainProj = projections.get(armband.captain, g);
    const captainExtra = captainProj && Number.isFinite(captainProj.xPoints) ? captainProj.xPoints : 0;
    const value = lineup.xPoints + captainExtra;
    const weight = Math.pow(discount, k);
    total += weight * value;
    byGw.push({
      gw: g,
      xPoints: lineup.xPoints,
      autosubValue: lineup.autosubValue,
      captain: armband.captain,
      viceCaptain: armband.viceCaptain,
      captainExtra,
      value,
      weight,
      formation: lineup.formation,
    });
  }

  return { total, byGw, gwFrom: gw, gwTo: last, discount };
}

export function squadHorizonValue(squadIds, projections, gw, rules, opts = {}) {
  const horizon = opts.horizon ?? DEFAULT_HORIZON;
  const discount = opts.discount ?? DEFAULT_DISCOUNT;
  const lineupOpts = { ...opts, mode: opts.mode || 'fast' };
  const last = Math.min(gw + horizon - 1, projections.gwTo);

  let total = 0;
  const byGw = [];
  for (let g = gw, k = 0; g <= last; g++, k++) {
    const lineup = optimizeLineup(squadIds, projections, g, rules, lineupOpts);
    let captainExtra = 0;
    for (const id of lineup.startingXI) {
      const proj = projections.get(id, g);
      if (proj && proj.xPoints > captainExtra) captainExtra = proj.xPoints;
    }
    const value = lineup.xPoints + lineup.autosubValue + captainExtra;
    const weight = Math.pow(discount, k);
    total += weight * value;
    byGw.push({
      gw: g,
      xPoints: lineup.xPoints,
      autosubValue: lineup.autosubValue,
      captainExtra,
      value,
      weight,
      formation: lineup.formation,
    });
  }

  return { total, byGw, gwFrom: gw, gwTo: last, discount };
}

export { DEFAULT_DISCOUNT, DEFAULT_HORIZON };
