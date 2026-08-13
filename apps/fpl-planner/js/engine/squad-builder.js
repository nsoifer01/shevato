// Building a whole fifteen from scratch.
//
// One function serves three jobs, because they are the same problem: the
// pre-season opening squad, a wildcard rebuild, and a free hit (which is the
// same build with the horizon collapsed to a single gameweek).
//
// WHAT IT MAXIMIZES, AND WHY THAT SENTENCE IS LOAD BEARING
//
// `squadObjective` from lineup.js, which is bit-identical to `squadTrajectory`
// from chips.js: the best legal eleven each gameweek plus the armband,
// discounted. That is the number the hero card prints, the number the chip
// evaluator compares against, and the number "why not this player" quotes.
//
// It used to maximize `squadHorizonValue` instead, which is the same shape with
// the bench's auto-substitution value added and the highest projected starter
// captained rather than the armband captain.js actually picks. The builder was
// therefore the best squad for a number nothing displayed, and the counterfactual
// then measured it against a number the builder had never optimized. A manager
// pre-season could read BUILD THIS OPENING 15 at 132.1 xP and, one screen below,
// "the best squad containing Haaland" at 134.2, which is a contradiction: the
// unconstrained search space contains every constrained one, so unrestricted can
// never be beaten by forced. Both figures were correct about their own objective
// and the pair was nonsense. See experiments/optimizer-self-consistency.md.
//
// WHY A HEURISTIC AND NOT AN EXACT SOLVER
//
// Picking fifteen players out of roughly six hundred under a budget, a
// per-position quota and a three-per-club limit is a multi-dimensional
// knapsack. It is exactly the shape of problem an integer-programming solver
// eats for breakfast, and if one were available that is what this would call.
// None is. This repo has ZERO npm dependencies, no bundler and no build step by
// design, and the same code has to run unchanged in a browser worker and under
// `node --test`. Shipping a solver would mean either a large vendored binary
// blob or a WASM download, both of which cost more than the last fraction of a
// point they would buy.
//
// Writing a branch-and-bound from scratch is not the answer either: the
// objective is not linear in the players. A player's contribution depends on
// whether he makes the eleven that week, which depends on the other fourteen,
// and on the formation, which also depends on the other fourteen. A solver
// would need the objective linearized first, and the linearization is a worse
// approximation than the search below.
//
// SO: greedy construction seeded several ways, then iterated local search over
// four neighbourhoods of increasing reach.
//
//   1. CONSTRUCTION. Players are ranked by value density, horizon points
//      divided by cost raised to alpha. Alpha 0 is "best players", alpha 1 is
//      "best points per million", and the seeds sweep between them, because
//      neither extreme builds a good squad on its own: alpha 0 runs out of
//      money and alpha 1 fills the eleven with cheap players who do not play.
//      Each pick is checked against the remaining budget's ability to still
//      fill every remaining slot, so construction cannot paint itself into a
//      corner.
//   2. ONE SWAP. Full first-improvement descent over the 1-swap neighbourhood
//      (replace one squad member with any pool player of the same position)
//      until no single swap improves.
//   3. TWO SWAPS. A random 2-swap phase, which escapes the 1-swap optima a
//      budget constraint creates: two upgrades that are each unaffordable alone
//      are affordable together when paired with a downgrade.
//   4. SWAP CHAINS. The neighbourhood that matters for a premium. Fitting a
//      15.5m striker needs two or three coordinated downgrades, and every
//      intermediate state on the way there is worse than where you started, so
//      no 1-swap or 2-swap descent can cross the valley. A chain move proposes
//      the upgrade and then REPAIRS the squad back to legality - freeing money
//      by the cheapest route in projected points, and freeing a club slot when
//      the three-per-club limit is what binds - and the whole chain is
//      evaluated as one move.
//   5. THE COUNTERFACTUAL CHALLENGE. The last pass forces in each of the top
//      excluded players in turn, exactly as the "why not this player" screen
//      does, and keeps any squad that comes back better. This is the pass that
//      makes the invariant hold rather than merely being asserted: if forcing a
//      player in improves the squad, the builder has already taken the
//      improvement and there is nothing left for the counterfactual to find.
//   6. PERTURB AND REPEAT. On stagnation the incumbent is kicked with a few
//      random feasible swaps and the descent restarts, keeping the best squad
//      ever seen. Several restarts from different seeds.
//
// Every proposal is repaired-or-rejected against the real constraints before it
// is scored, so every squad this function ever evaluates is legal.
//
// FAST INNER LOOP, EXACT ANSWER. The search ranks on the objective in the
// lineup optimizer's `fast` mode, which is an approximation of the same
// quantity (see lineup.js). Ranking thousands of squads on the exact model
// costs 6ms each and is not affordable. So the search keeps an ELITE POOL of
// the best distinct squads it has seen, re-scores every one of them on the
// EXACT objective at the end, and returns the winner of that. The number
// returned is therefore always the exact objective, and the fast/exact gap can
// only cost the last fraction of a point of ranking rather than silently
// changing what the answer means.
//
// DETERMINISM. All randomness comes from `makeRng(opts.seed)`. The same inputs
// and the same seed produce the same squad, every time, in any engine.

import { makeRng } from './ml.js';
import { squadObjective, DEFAULT_DISCOUNT, DEFAULT_HORIZON } from './lineup.js';

const UNBUYABLE_STATUSES = new Set(['u', 'n']);

// Value-density exponents used to seed construction, from "best players" to
// "best points per million".
const SEED_ALPHAS = [0, 0.35, 0.7, 1];

export const SQUAD_BUILDER_DEFAULTS = Object.freeze({
  // An arbitrary constant fed to makeRng() so restarts are reproducible. Any
  // integer works identically; nothing reads it as a date or a gameweek.
  //
  // It used to be 20260821, which is the GW1 deadline written as digits. That
  // was never a season assumption, but it tripped the "no hardcoded season"
  // check on sight, and a constant that has to be explained every time someone
  // greps for a year is worth one renumber. Deliberately not date shaped now.
  seed: 1618033,
  restarts: 4,
  poolPerPosition: 30,
  cheapPerPosition: 6,
  // How many improving swaps ONE descent may make before it gives up. This is
  // not a time budget: the descent stops on its own the moment no single swap
  // improves, and on the sample dataset it converges in under twenty. It used
  // to be six, which cut every descent off in the middle and left the search
  // depending on restarts to finish the job. Six could not reach the best
  // fifteen from any of its four constructions; twelve could, and twenty and
  // forty evaluate exactly the same number of squads as each other, which is
  // what "converged" looks like.
  descentRounds: 20,
  pairIterations: 250,
  perturbStrength: 3,
  perturbRounds: 2,
  // Upgrades tried per slot in the chain pass, best projected first.
  chainCandidates: 6,
  // How many other players a chain may downgrade to pay for the upgrade.
  //
  // This number is the width of the valley the search can cross, and it was
  // measured rather than guessed. On the sample dataset the best fifteen holds
  // a 15.4m striker, and reaching it from the squad the cheap neighbourhoods
  // settle on takes FOUR downgrades (8.0m to 5.0m at the back, 9.6m to 6.0m and
  // 8.0m to 7.0m in midfield, 5.5m to 4.5m in goal) before the money is there.
  // At three the chain fell 0.4m short, the move was rejected, and forcing that
  // striker in from the counterfactual screen then beat the recommendation by
  // 0.22 points. Six leaves room for a premium plus a bench rebuild.
  chainRepairSteps: 6,
  // Chain-then-descend cycles run on the incumbent before it is returned.
  intensifyRounds: 3,
  // Excluded players forced in by the final challenge pass, best projected
  // first. This is the pass that closes the counterfactual gap. Twelve was
  // where the measured gap stopped moving: at zero the search left 0.23 points
  // on the table for anyone who asked about a premium, at twelve it left 0.014,
  // and at forty it left the same 0.014 for twice the time.
  challengers: 24,
  // Descent rounds allowed inside a challenge. A challenge starts either from
  // the incumbent with one player swapped in or from a construction built
  // around him, and the second of those is a long way from a local optimum, so
  // this cannot be the two or three rounds a polish would need.
  challengeDescentRounds: 12,
  // Distinct squads carried to the exact re-score.
  elitePool: 16,
  horizon: DEFAULT_HORIZON,
  discount: DEFAULT_DISCOUNT,
  risk: 'balanced',
});

const keyOf = (squad) => squad.slice().sort((a, b) => a - b).join(',');

export function buildSquad({
  projections,
  gameState,
  rules,
  gw,
  horizon,
  budgetTenths,
  lockedIds = [],
  bannedIds = [],
  opts = {},
}) {
  const R = rules || gameState.rules;
  const cfg = { ...SQUAD_BUILDER_DEFAULTS, ...opts };
  if (horizon !== undefined && horizon !== null) cfg.horizon = horizon;
  if (cfg.singleGw) cfg.horizon = 1;

  const budget = budgetTenths ?? R.budgetTenths;
  const players = gameState.players;
  const banned = new Set(bannedIds);
  const locked = lockedIds.slice();

  const lineupOpts = {
    gameState,
    risk: cfg.risk,
    riskAversion: cfg.riskAversion,
    minutesRiskWeight: cfg.minutesRiskWeight,
    horizon: cfg.horizon,
    discount: cfg.discount,
    // Lives exactly as long as this build. The risk profile is fixed for the
    // whole call, so an eleven's armband cannot change under the cache.
    armbandCache: new Map(),
  };

  const lastGw = Math.min(gw + cfg.horizon - 1, projections.gwTo);
  const pools = buildPools({ players, projections, gw, lastGw, cfg, R, banned, locked });

  const positionIds = Object.keys(R.positions).map(Number).sort((a, b) => a - b);
  const quota = new Map(positionIds.map(id => [id, R.positions[id].squadSelect]));

  const poolById = new Map();
  for (const pool of pools.values()) for (const entry of pool) poolById.set(entry.id, entry);

  // Discounted horizon points for anyone, pool member or not. The repair greedy
  // ranks downgrades on this, and a squad handed in through `seedSquads` can
  // hold a player the pool never shortlisted; valuing him at zero would make
  // selling him look free.
  const valueOf = (id) => {
    let value = 0;
    for (let g = gw, k = 0; g <= lastGw; g++, k++) {
      const proj = projections.get(id, g);
      if (proj) value += Math.pow(cfg.discount, k) * proj.xPoints;
    }
    return value;
  };

  const cache = new Map();
  const evaluate = (squad) => {
    const key = keyOf(squad);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = squadObjective(squad, projections, gw, R, { ...lineupOpts, mode: 'fast' }).total;
    cache.set(key, value);
    return value;
  };

  const elite = makeElite(cfg.elitePool);
  const ctx = {
    players, pools, poolById, quota, positionIds, budget,
    clubLimit: R.clubLimit, locked: new Set(locked), evaluate, elite, valueOf,
    extraValues: new Map(),
  };

  let best = null;
  const offer = (squad, value) => {
    elite.add(squad, value);
    if (!best || value > best.value) best = { squad: squad.slice(), value };
  };

  // A caller may hand in squads to start from. `counterfactual.js` uses this to
  // re-run the unconstrained search from a squad that a CONSTRAINED search
  // found, which is the one starting point an unconstrained search cannot
  // produce for itself and is exactly the case where the two disagree.
  const seeds = (opts.seedSquads || []).filter(s => Array.isArray(s) && s.length === R.squadSize);

  for (let restart = 0; restart < cfg.restarts + seeds.length; restart++) {
    const rng = makeRng(cfg.seed + restart * 7919);
    const seeded = restart < seeds.length ? seeds[restart] : null;
    const n = restart - seeds.length;
    const squad = seeded
      ? seeded.slice()
      : construct(ctx, SEED_ALPHAS[n % SEED_ALPHAS.length], rng, n >= SEED_ALPHAS.length ? 0.25 : 0);
    if (!squad) continue;

    let incumbent = { squad, value: evaluate(squad) };
    offer(incumbent.squad, incumbent.value);

    for (let round = 0; round <= cfg.perturbRounds; round++) {
      const improved = localSearch(ctx, incumbent.squad, cfg, rng);
      if (improved.value > incumbent.value) incumbent = improved;
      offer(improved.squad, improved.value);
      if (round < cfg.perturbRounds) {
        const kicked = perturb(ctx, incumbent.squad, cfg.perturbStrength, rng);
        incumbent = { squad: kicked, value: evaluate(kicked) };
      }
    }
  }

  if (!best) {
    throw new Error('No legal squad could be built: the candidate pool cannot fill every position inside the budget.');
  }

  // The chain and challenge passes are reach, not breadth, so they run once on
  // the best squad the restarts produced rather than inside every descent. Run
  // per descent they cost five times the whole search and found the same squad.
  best = intensify(ctx, best, cfg, offer);
  best = challenge(ctx, best, cfg, makeRng(cfg.seed + 104729), offer);

  // The exact objective decides. Every elite squad is re-scored on it, so the
  // answer is the best squad this search found measured the way the app reports
  // it, not the best squad measured the way the search ranked it.
  const exactOpts = { ...lineupOpts, mode: 'exact' };
  let winner = null;
  for (const item of elite.list()) {
    const result = squadObjective(item.squad, projections, gw, R, exactOpts);
    if (winner === null
      || result.total > winner.result.total + 1e-12
      || (Math.abs(result.total - winner.result.total) <= 1e-12 && item.key < winner.key)) {
      winner = { key: item.key, squad: item.squad, result, searchValue: item.value };
    }
  }

  const squad = winner.squad.slice().sort((a, b) => {
    const pa = players.get(a).position;
    const pb = players.get(b).position;
    return pa !== pb ? pa - pb : a - b;
  });

  const costTenths = squad.reduce((sum, id) => sum + players.get(id).nowCost, 0);

  return {
    squad,
    costTenths,
    bankTenths: budget - costTenths,
    xPointsHorizon: winner.result.total,
    byGw: winner.result.byGw,
    searchValue: winner.searchValue,
    evaluations: cache.size,
    horizon: cfg.horizon,
    seed: cfg.seed,
  };
}

// ---------------------------------------------------------------------------

// The best distinct squads seen, carried to the exact re-score. Bounded, so a
// ten thousand evaluation search does not hold ten thousand arrays.
function makeElite(limit) {
  const items = [];
  const keys = new Set();
  return {
    add(squad, value) {
      if (items.length >= limit && value <= items[items.length - 1].value) return;
      const key = keyOf(squad);
      if (keys.has(key)) return;
      keys.add(key);
      items.push({ key, squad: squad.slice(), value });
      items.sort((a, b) => (b.value - a.value) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      while (items.length > limit) keys.delete(items.pop().key);
    },
    list: () => items,
  };
}

function buildPools({ players, projections, gw, lastGw, cfg, R, banned, locked }) {
  const lockedSet = new Set(locked);
  const byPosition = new Map();

  for (const id of projections.byPlayer.keys()) {
    const player = players.get(id);
    if (!player) continue;
    if (banned.has(id)) continue;
    if (UNBUYABLE_STATUSES.has(player.status) && !lockedSet.has(id)) continue;

    let value = 0;
    for (let g = gw, k = 0; g <= lastGw; g++, k++) {
      const proj = projections.get(id, g);
      if (proj) value += Math.pow(cfg.discount, k) * proj.xPoints;
    }
    if (!byPosition.has(player.position)) byPosition.set(player.position, []);
    byPosition.get(player.position).push({ id, nowCost: player.nowCost, teamId: player.teamId, value });
  }

  const pools = new Map();
  for (const pos of Object.keys(R.positions).map(Number)) {
    const all = byPosition.get(pos) || [];
    const byValue = all.slice().sort((a, b) => (b.value - a.value) || (a.id - b.id));
    const kept = byValue.slice(0, cfg.poolPerPosition);
    const keptIds = new Set(kept.map(p => p.id));

    // The cheapest players are kept whatever their value: a legal fifteen needs
    // four bench slots filled, and a pool of only premium players cannot pay
    // for the eleven that matters.
    const byPrice = all.slice().sort((a, b) => (a.nowCost - b.nowCost) || (b.value - a.value) || (a.id - b.id));
    for (const p of byPrice.slice(0, cfg.cheapPerPosition)) {
      if (!keptIds.has(p.id)) {
        kept.push(p);
        keptIds.add(p.id);
      }
    }
    for (const id of lockedSet) {
      const player = players.get(id);
      if (player && player.position === pos && !keptIds.has(id)) {
        let value = 0;
        for (let g = gw, k = 0; g <= lastGw; g++, k++) {
          const proj = projections.get(id, g);
          if (proj) value += Math.pow(cfg.discount, k) * proj.xPoints;
        }
        kept.push({ id, nowCost: player.nowCost, teamId: player.teamId, value });
        keptIds.add(id);
      }
    }

    kept.sort((a, b) => (b.value - a.value) || (a.id - b.id));
    pools.set(pos, kept);
  }
  return pools;
}

// The cost of an actual cheap, legal way to fill every slot the squad still
// needs, given who has already been taken and how full each club is. This is
// the floor construction checks a candidate against, so it has to reserve REAL
// players: counting a player who is already in the squad, or one from a club
// that is already at the limit, understates the money still owed and walks
// construction into a corner it cannot buy its way out of.
//
// Infinity means there is no legal completion left at all, which makes the
// candidate that produced it unplayable rather than merely expensive.
function completionFloor({ byPrice, positionIds, need, chosen, clubCounts, clubLimit, skipPosition, cand }) {
  const counts = new Map(clubCounts);
  const reserved = new Set(chosen);
  if (cand) {
    counts.set(cand.teamId, (counts.get(cand.teamId) || 0) + 1);
    reserved.add(cand.id);
  }

  let total = 0;
  for (const pos of positionIds) {
    const n = need.get(pos) - (pos === skipPosition ? 1 : 0);
    if (n <= 0) continue;
    let taken = 0;
    for (const p of byPrice.get(pos)) {
      if (taken === n) break;
      if (reserved.has(p.id)) continue;
      if ((counts.get(p.teamId) || 0) >= clubLimit) continue;
      reserved.add(p.id);
      counts.set(p.teamId, (counts.get(p.teamId) || 0) + 1);
      total += p.nowCost;
      taken++;
    }
    if (taken < n) return Infinity;
  }
  return total;
}

function construct(ctx, alpha, rng, jitter) {
  const { pools, quota, positionIds, budget, clubLimit, players } = ctx;
  const byPrice = new Map([...pools].map(([pos, pool]) => [
    pos,
    pool.slice().sort((a, b) => (a.nowCost - b.nowCost) || (a.id - b.id)),
  ]));

  const need = new Map(quota);
  const clubCounts = new Map();
  const chosen = new Set();
  let spent = 0;

  const take = (cand, position) => {
    chosen.add(cand.id);
    spent += cand.nowCost;
    need.set(position, need.get(position) - 1);
    clubCounts.set(cand.teamId, (clubCounts.get(cand.teamId) || 0) + 1);
  };

  for (const id of ctx.locked) {
    const player = players.get(id);
    const position = player.position;
    if (need.get(position) <= 0) continue;
    take({ id, nowCost: player.nowCost, teamId: player.teamId }, position);
  }

  const remainingFloor = (skipPosition, cand) => completionFloor({
    byPrice, positionIds, need, chosen, clubCounts, clubLimit, skipPosition, cand,
  });

  let guard = 0;
  while ([...need.values()].some(n => n > 0)) {
    if (guard++ > 200) return null;

    let bestCand = null;
    let bestScore = -Infinity;
    let bestPosition = null;

    for (const pos of positionIds) {
      if (need.get(pos) <= 0) continue;
      for (const cand of pools.get(pos)) {
        if (chosen.has(cand.id)) continue;
        if ((clubCounts.get(cand.teamId) || 0) >= clubLimit) continue;
        const floorAfter = remainingFloor(pos, cand);
        if (cand.nowCost > budget - spent - floorAfter) continue;
        const density = cand.value / Math.pow(Math.max(1, cand.nowCost) / 10, alpha);
        const score = jitter ? density * (1 - jitter + 2 * jitter * rng()) : density;
        if (score > bestScore) {
          bestScore = score;
          bestCand = cand;
          bestPosition = pos;
        }
      }
    }

    if (!bestCand) return null;
    take(bestCand, bestPosition);
  }

  return [...chosen];
}

// ---------------------------------------------------------------------------

function squadState(ctx, squad) {
  const { players, clubLimit } = ctx;
  const clubCounts = new Map();
  let cost = 0;
  for (const id of squad) {
    const p = players.get(id);
    cost += p.nowCost;
    clubCounts.set(p.teamId, (clubCounts.get(p.teamId) || 0) + 1);
  }
  return { clubCounts, cost, clubLimit };
}

function feasibleSwap(ctx, state, outIds, inCands) {
  let cost = state.cost;
  const counts = new Map(state.clubCounts);
  for (const id of outIds) {
    const p = ctx.players.get(id);
    cost -= p.nowCost;
    counts.set(p.teamId, counts.get(p.teamId) - 1);
  }
  for (const cand of inCands) {
    cost += cand.nowCost;
    const n = (counts.get(cand.teamId) || 0) + 1;
    if (n > ctx.clubLimit) return false;
    counts.set(cand.teamId, n);
  }
  return cost <= ctx.budget;
}

// A pool entry for anyone in the squad. Locked players are always in the pool
// (buildPools puts them there), so this only ever falls back for a player a
// seed squad brought in from outside the shortlist.
function entryOf(ctx, id) {
  const hit = ctx.poolById.get(id);
  if (hit) return hit;
  const cached = ctx.extraValues.get(id);
  if (cached) return cached;
  const p = ctx.players.get(id);
  const entry = { id, nowCost: p.nowCost, teamId: p.teamId, value: ctx.valueOf(id) };
  ctx.extraValues.set(id, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Repair: put an illegal squad back inside the rules for the least projected
// points, or give up.
//
// This is what makes a swap CHAIN possible. A move that buys a premium leaves
// the squad over budget, or over the three-per-club limit, or both, and every
// single step back towards legality looks like a downgrade. Repairing the whole
// thing before scoring it means the objective sees the finished chain rather
// than its worst intermediate state.
//
// Money is freed by the cheapest route in projected points per tenth freed,
// which is the greedy that a manager doing this by hand also uses. A club slot
// is freed by replacing the least valuable player of the offending club with
// the best pool player of his position from a club with room.
// ---------------------------------------------------------------------------
function repair(ctx, squad, protectedIds, maxSteps) {
  const out = squad.slice();
  const protectedSet = new Set([...protectedIds, ...ctx.locked]);

  for (let step = 0; step <= maxSteps; step++) {
    const state = squadState(ctx, out);
    const inSquad = new Set(out);

    // Club limit first: it is a hard count, and the swap that fixes it also
    // moves money, so fixing it before the budget avoids undoing work.
    let overClub = null;
    for (const [teamId, n] of state.clubCounts) {
      if (n > ctx.clubLimit) { overClub = teamId; break; }
    }

    if (overClub !== null) {
      let move = null;
      for (let i = 0; i < out.length; i++) {
        const id = out[i];
        if (protectedSet.has(id)) continue;
        const held = entryOf(ctx, id);
        if (held.teamId !== overClub) continue;
        const position = ctx.players.get(id).position;
        for (const cand of ctx.pools.get(position)) {
          if (inSquad.has(cand.id)) continue;
          if (cand.teamId === overClub) continue;
          if ((state.clubCounts.get(cand.teamId) || 0) >= ctx.clubLimit) continue;
          const loss = held.value - cand.value;
          const extra = cand.nowCost - held.nowCost;
          if (move === null || loss < move.loss || (loss === move.loss && extra < move.extra)) {
            move = { index: i, id: cand.id, loss, extra };
          }
        }
      }
      if (!move) return null;
      out[move.index] = move.id;
      continue;
    }

    if (state.cost <= ctx.budget) return out;

    const deficit = state.cost - ctx.budget;
    let move = null;
    for (let i = 0; i < out.length; i++) {
      const id = out[i];
      if (protectedSet.has(id)) continue;
      const held = entryOf(ctx, id);
      const position = ctx.players.get(id).position;
      for (const cand of ctx.pools.get(position)) {
        if (inSquad.has(cand.id)) continue;
        const saving = held.nowCost - cand.nowCost;
        if (saving <= 0) continue;
        if (cand.teamId !== held.teamId && (state.clubCounts.get(cand.teamId) || 0) >= ctx.clubLimit) continue;
        const loss = held.value - cand.value;
        // Points given up per tenth freed, and a swap that clears the whole
        // deficit in one is preferred to two that each clear half.
        const clears = saving >= deficit ? 0 : 1;
        const rate = loss / saving;
        if (move === null
          || clears < move.clears
          || (clears === move.clears && rate < move.rate)
          || (clears === move.clears && rate === move.rate && saving > move.saving)) {
          move = { index: i, id: cand.id, clears, rate, saving };
        }
      }
    }
    if (!move) return null;
    out[move.index] = move.id;
  }

  const finalState = squadState(ctx, out);
  if (finalState.cost > ctx.budget) return null;
  for (const [, n] of finalState.clubCounts) if (n > ctx.clubLimit) return null;
  return out;
}

// Bring `cand` into the squad at `index`, then repair. Returns null when no
// legal repair exists.
function chainInto(ctx, squad, index, cand, cfg) {
  if (squad.includes(cand.id)) return null;
  const next = squad.slice();
  next[index] = cand.id;
  return repair(ctx, next, [cand.id], cfg.chainRepairSteps);
}

// The chain neighbourhood: every upgrade at every slot, paid for by repairing
// the rest of the squad. Best-improvement, because the point of the pass is to
// find the one expensive move that the cheap neighbourhoods cannot see.
function chainPass(ctx, startSquad, startValue, cfg) {
  let squad = startSquad;
  let value = startValue;
  let improvements = 0;

  for (let i = 0; i < squad.length; i++) {
    const outId = squad[i];
    if (ctx.locked.has(outId)) continue;
    const held = entryOf(ctx, outId);
    const pool = ctx.pools.get(ctx.players.get(outId).position);
    const inSquad = new Set(squad);

    let tried = 0;
    for (const cand of pool) {
      if (tried >= cfg.chainCandidates) break;
      if (inSquad.has(cand.id)) continue;
      if (cand.value <= held.value) continue;
      if (cand.nowCost <= held.nowCost) continue;
      tried++;
      const repaired = chainInto(ctx, squad, i, cand, cfg);
      if (!repaired) continue;
      const v = ctx.evaluate(repaired);
      if (v > value + 1e-9) {
        squad = repaired;
        value = v;
        ctx.elite.add(squad, value);
        // A chain rewrites several slots, so the pass starts again rather than
        // carrying on down a squad that no longer exists. Bounded so a long
        // ladder of tiny improvements cannot run the pass indefinitely.
        if (++improvements >= cfg.chainCandidates * 4) return { squad, value };
        i = -1;
        break;
      }
    }
  }

  return { squad, value };
}

// Chain moves and the 1-swap descent alternated until neither improves. This is
// the pass that crosses a budget valley: the chain buys the premium and pays for
// it in one move, the descent then tidies up the players it downgraded.
function intensify(ctx, start, cfg, offer) {
  let best = start;
  for (let round = 0; round < cfg.intensifyRounds; round++) {
    const chained = chainPass(ctx, best.squad, best.value, cfg);
    const polished = descentOnly(ctx, chained.squad, chained.value, cfg);
    if (polished.value <= best.value + 1e-9) break;
    best = { squad: polished.squad.slice(), value: polished.value };
    if (offer) offer(best.squad, best.value);
  }
  return best;
}

// First-improvement descent over every single swap, then a randomized 2-swap
// phase. The 2-swap phase exists because the budget makes 1-swap optima common:
// the upgrade you want is 0.3m out of reach until something else is downgraded.
function localSearch(ctx, startSquad, cfg, rng) {
  let squad = descentOnly(ctx, startSquad, ctx.evaluate(startSquad), cfg).squad;
  let value = ctx.evaluate(squad);

  const state = squadState(ctx, squad);
  for (let it = 0; it < cfg.pairIterations; it++) {
    const i = Math.floor(rng() * squad.length);
    const j = Math.floor(rng() * squad.length);
    if (i === j) continue;
    const outA = squad[i];
    const outB = squad[j];
    if (ctx.locked.has(outA) || ctx.locked.has(outB)) continue;

    const poolA = ctx.pools.get(ctx.players.get(outA).position);
    const poolB = ctx.pools.get(ctx.players.get(outB).position);
    const candA = poolA[Math.floor(rng() * poolA.length)];
    const candB = poolB[Math.floor(rng() * poolB.length)];
    if (!candA || !candB || candA.id === candB.id) continue;
    if (squad.includes(candA.id) || squad.includes(candB.id)) continue;
    if (!feasibleSwap(ctx, state, [outA, outB], [candA, candB])) continue;

    const next = squad.slice();
    next[i] = candA.id;
    next[j] = candB.id;
    const v = ctx.evaluate(next);
    if (v > value + 1e-9) {
      squad = next;
      value = v;
      const fresh = squadState(ctx, squad);
      state.cost = fresh.cost;
      state.clubCounts = fresh.clubCounts;
    }
  }

  return { squad, value };
}

function descentOnly(ctx, startSquad, startValue, cfg, rounds = cfg.descentRounds) {
  let squad = startSquad.slice();
  let value = startValue;

  for (let round = 0; round < rounds; round++) {
    let improved = false;
    const state = squadState(ctx, squad);
    const inSquad = new Set(squad);
    for (let i = 0; i < squad.length; i++) {
      const outId = squad[i];
      if (ctx.locked.has(outId)) continue;
      const position = ctx.players.get(outId).position;
      for (const cand of ctx.pools.get(position)) {
        if (inSquad.has(cand.id)) continue;
        if (!feasibleSwap(ctx, state, [outId], [cand])) continue;
        const next = squad.slice();
        next[i] = cand.id;
        const v = ctx.evaluate(next);
        if (v > value + 1e-9) {
          squad = next;
          value = v;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
    if (!improved) break;
  }
  return { squad, value };
}

// ---------------------------------------------------------------------------
// The counterfactual challenge.
//
// The last thing the search does is ask its own question back: for each of the
// best excluded players, what is the best squad that CONTAINS him? If any
// answer beats the incumbent, the incumbent was not the best squad and the
// better one is taken.
//
// This is not a nicety. Without it the builder's answer is only a local optimum
// of the unconstrained search, and "why not this player" runs a differently
// seeded search of a SUBSET of the same space, which can and did land higher.
// Two searches of nested spaces disagreeing is a search failure, but on screen
// it reads as the app admitting its own recommendation is beatable.
// ---------------------------------------------------------------------------
function challenge(ctx, best, cfg, rng, offer) {
  if (!cfg.challengers) return best;

  const candidates = [];
  for (const pool of ctx.pools.values()) for (const entry of pool) candidates.push(entry);
  candidates.sort((a, b) => (b.value - a.value) || (a.id - b.id));

  let current = best;
  for (const cand of candidates.slice(0, cfg.challengers)) {
    if (current.squad.includes(cand.id)) continue;
    const position = ctx.players.get(cand.id).position;

    const forced = { ...ctx, locked: new Set([...ctx.locked, cand.id]) };

    // Two kinds of start, because they land in different basins and the
    // counterfactual's own build uses the second.
    //
    //   REPAIR. Every legal way of getting him into the incumbent, one slot at
    //   a time, each repaired back inside the budget and the club limit.
    //   CONSTRUCT. The greedy construction the constrained build itself would
    //   run, with him taken first. This is what finds a squad built AROUND a
    //   premium rather than one with a premium bolted on, and skipping it was
    //   how a forced build could still come back better.
    let seeded = null;
    const consider = (squad) => {
      if (!squad) return;
      const v = ctx.evaluate(squad);
      if (!seeded || v > seeded.value) seeded = { squad, value: v };
    };
    for (let i = 0; i < current.squad.length; i++) {
      if (ctx.players.get(current.squad[i]).position !== position) continue;
      if (ctx.locked.has(current.squad[i])) continue;
      consider(chainInto(ctx, current.squad, i, cand, cfg));
    }
    for (const alpha of SEED_ALPHAS) consider(construct(forced, alpha, rng, 0));
    if (!seeded) continue;

    let improved = descentOnly(forced, seeded.squad, seeded.value, cfg, cfg.challengeDescentRounds);
    improved = intensify(forced, improved, cfg, null);
    offer(improved.squad, improved.value);
    if (improved.value > current.value + 1e-9) current = { squad: improved.squad.slice(), value: improved.value };
  }

  return current;
}

function perturb(ctx, startSquad, strength, rng) {
  const squad = startSquad.slice();
  for (let k = 0; k < strength; k++) {
    const state = squadState(ctx, squad);
    const i = Math.floor(rng() * squad.length);
    const outId = squad[i];
    if (ctx.locked.has(outId)) continue;
    const pool = ctx.pools.get(ctx.players.get(outId).position);
    const cand = pool[Math.floor(rng() * pool.length)];
    if (!cand || squad.includes(cand.id)) continue;
    if (!feasibleSwap(ctx, state, [outId], [cand])) continue;
    squad[i] = cand.id;
  }
  return squad;
}
