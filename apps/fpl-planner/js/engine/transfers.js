// Transfer search: zero, one and two transfers, hits, and rolling.
//
// This is the decision the product exists to make, and the one where an
// illegal or unaffordable suggestion destroys trust, so legality is checked
// inside this engine and never left to the UI.
//
// WHAT IS ENUMERATED
//
//   0 transfers  the roll, always generated, always ranked alongside the rest
//   1 transfer   every owned player against a pruned incoming pool
//   2 transfers  a pruned set of outgoing pairs against pruned incoming pairs
//
// Any plan whose transfer count exceeds the banked free transfers is a hit
// plan; hits above `opts.maxHits` are never generated.
//
// THE PRUNING RULE, stated because a two-transfer search over 600 players is
// 10^10 pairs and cannot be enumerated:
//
//   1. A player is a legal purchase only if he is not already owned and his
//      status is not "unavailable" or "not in squad" (FPL lists players who
//      have left; buying one is not a plan).
//   2. AFFORDABILITY BAND. For a one-transfer search the incoming pool for a
//      position is capped at `bank + the largest selling price owned in that
//      position`, which is the most money a single sale there can ever free.
//      For the pair search the band widens to the two largest.
//   3. VALUE RANK. Inside the band, players are ranked by discounted horizon
//      expected points and the top `poolPerPosition` are kept.
//   4. ENABLERS. The `enablersPerPosition` cheapest legal players per position
//      are kept regardless of rank, because the two-transfer move that matters
//      most often is a downgrade funding an upgrade, and a pure value ranking
//      never surfaces the downgrade.
//   5. OUTGOING PRUNE. Two-transfer outgoing pairs are drawn only from the
//      `maxOutCandidates` players with the largest available upgrade (the best
//      affordable replacement's horizon value minus their own), unioned with
//      the players who free the most cash per point of value, which is the
//      other half of a funding move.
//
// Every generated candidate is checked for squad-position counts, club limit,
// affordability to the tenth using SELLING prices, and hit count BEFORE it is
// scored. Illegal candidates never reach the scorer.
//
// HOW A CANDIDATE IS SCORED
//
//   score = discounted horizon squad value
//         - hits * rules.hitCost         (the actual points cost)
//         - hits * hitMargin             (the documented margin a hit must clear)
//         + rollValue                    (what keeping a free transfer is worth)
//
// The horizon value is the squad's best legal eleven each gameweek plus what
// auto-substitutions recover from the bench plus the armband, discounted per
// gameweek (see lineup.js squadHorizonValue).
//
// ROLLING IS A FIRST-CLASS CANDIDATE. A banked free transfer is an option on a
// better move next week, and it is worth `ftValuePoints` per transfer carried
// beyond the one that arrives free anyway:
//
//   rollValue = ftValuePoints * max(0, freeTransfersNextGw - 1)
//
// where `freeTransfersNextGw` comes from transfer-state.js, the one module that
// owns the rollover and its cap.
//
// What decides anything is the DIFFERENCE between candidates, and that
// difference falls to zero at the free-transfer cap: a manager holding the
// maximum loses nothing by spending one, because the transfer he would have
// kept could never have become a sixth.
//
// A HIT MUST CLEAR MORE THAN ITS COST. Subtracting only the four points would
// make a 4.1-point gain a recommended hit, and a 4.1-point gain over a five
// gameweek horizon is inside the model's own error. `hitMargin` is the buffer
// that keeps the engine from selling certainty for noise.
//
// SELLING A DOUBT: `retentionCredit`, MEASURED AND SHIPPED AT ZERO
//
// The horizon is three gameweeks. A squad is not. When a player the squad
// already owns picks up a doubt, his horizon value collapses, the search reads
// that collapse as a permanent decline, and it sells him. Two or three
// gameweeks later he is fit, he is the best player available again, and the
// planner buys him back. The round trip costs two transfers and any cash the
// sell-on fee destroyed, and it was never a decision about the player at all.
// experiments/availability-minutes.md diagnosed exactly this: with a real
// injury signal wired in, the minutes model improved on every prediction metric
// and the planner still lost points, because the transfer engine reacted to
// every doubt.
//
// `retentionCredit` is the share of a transfer gain that is treated as
// manufactured by the doubt rather than real, and refunded to the player being
// sold:
//
//   doubt(out)  = 1 - availability(out)      (0 when he is fit, 0 when he is
//                                             ruled out entirely)
//   churnCost   = retentionCredit * SUM over pairs of
//                   doubt(out_i) * max(0, value(in_i) - value(out_i))
//
// WHY THAT SHAPE. `value(in) - value(out)` is the whole reason the search wants
// the swap. If the outgoing player would rank at or above his replacement when
// fit, which is the premise of ever buying him back, then every point of that
// gap is an artefact of the doubt. `doubt` is the probability the artefact
// applies to the gameweek being decided, so `doubt * gap` is the part of the
// apparent gain that a fit player would not have handed over, and
// `retentionCredit` is how much of it the engine refuses to spend a transfer
// on. It is bounded by the gain itself, so it can never invent a reason to make
// a losing transfer, and it is zero for every candidate that sells nobody.
//
// WHY NOT CHARGE THE CASH SPREAD. The obvious alternative is to charge
// `nowCost - sellingTenths`, the money FPL destroys on every sale. It was
// measured and it cannot work: across a replayed season the planner destroys 30
// to 44 tenths in TOTAL, 66% to 79% of sales destroy nothing at all, and the
// figure falls rather than rises once the injury signal is on, because the
// sell-on fee applies only to a price RISE and a player who has just gone down
// is not rising. The cash spread is real, it is just too small to be a
// mechanism, and it is smallest exactly where the churn is worst.
//
// WHY ONLY THE PLAYER GOING OUT. Retaining a player already owned costs
// nothing; acquiring a doubtful one costs a transfer now against value later,
// which is a different and worse bet. The incoming pool is ranked on horizon
// value, so a doubtful buy is already unlikely to surface, and nothing here
// should make it more likely.
//
// WHY A DOUBT OF ZERO AND A DOUBT OF ONE ARE BOTH FREE TO SELL. Availability
// comes from `availabilityCeiling` in minutes.js, so this reads the same number
// the projection did. A fit player has availability 1 and no protection, which
// is the point. A player FPL has ruled out has availability 0: there is no
// doubt to be wrong about, selling him is not a knee-jerk, and protecting him
// would be the engine refusing to move on from a season-ending injury.
//
// WHY IT SHIPS AT ZERO. It was swept from 0 to 1 and it does not win points.
// The mechanism is not broken: at 0.5 it cuts sales of doubtful players by 15%
// in 2023-24 and 38% in 2024-25 and the round trips fall with them, so the churn
// really does go away. The points do not follow. Over 45 replayed trajectories
// the best setting is worth +1.9 points each with a standard error of 3.5, and
// everything from 0.75 up is clearly negative. experiments/transfer-churn.md has
// the sweep, both measurement protocols and the reasoning. The parameter stays
// because the finding is worth being able to reproduce, and at zero the search
// is bit-for-bit what it was before it existed.

import { squadHorizonValue, optimizeLineup, DEFAULT_DISCOUNT, DEFAULT_HORIZON } from './lineup.js';
import { availabilityCeiling } from './minutes.js';
import { chooseCaptain } from './captain.js';
import { validatePlan } from './validate.js';
import { transferAccounting, transferStateOf, freeTransfersFor } from './transfer-state.js';

const UNBUYABLE_STATUSES = new Set(['u', 'n']);

export const TRANSFER_DEFAULTS = Object.freeze({
  horizon: DEFAULT_HORIZON,
  discount: DEFAULT_DISCOUNT,
  maxTransfers: 2,
  maxHits: 2,
  poolPerPosition: 24,
  pairPoolPerPosition: 8,
  enablersPerPosition: 4,
  maxOutCandidates: 8,
  maxCandidates: 12,
  // How many of the fast-ranked candidates are re-scored under the exact
  // lineup objective before the winner and the alternatives are chosen. Each
  // one costs a full exact lineup per gameweek of the horizon, so this is the
  // knob that trades search time for agreement with how the squad is played.
  rerankCandidates: 16,
  // Points a hit must beat ON TOP of rules.hitCost before it is recommended.
  hitMargin: 1.5,
  // What one banked free transfer is worth as an option on a future move.
  ftValuePoints: 1.2,
  // Share of a doubt-driven transfer gain the engine refuses to act on, so a
  // temporary absence is not converted into a permanent transaction. ZERO on
  // the evidence: see the header and experiments/transfer-churn.md.
  retentionCredit: 0,
  risk: 'balanced',
});

// ---------------------------------------------------------------------------

export function searchTransfers({ squadState, projections, gameState, rules, horizon, opts = {} }) {
  const R = rules || gameState.rules;
  const cfg = { ...TRANSFER_DEFAULTS, ...opts };
  if (horizon !== undefined && horizon !== null) cfg.horizon = horizon;

  const gw = squadState.gw;
  const players = gameState.players;
  const picks = squadState.picks || [];

  if (picks.length !== R.squadSize) {
    throw new Error(`searchTransfers needs a full squad of ${R.squadSize}; use buildSquad for a pre-season or wildcard build.`);
  }

  const owned = new Map(picks.map(p => [p.playerId, p]));
  const ownedIds = picks.map(p => p.playerId);
  const bankBefore = squadState.bankTenths;
  const transferState = transferStateOf(squadState, R);
  const freeTransfers = freeTransfersFor(transferState);

  const lineupOpts = {
    gameState,
    risk: cfg.risk,
    riskAversion: cfg.riskAversion,
    minutesRiskWeight: cfg.minutesRiskWeight,
  };
  const horizonOpts = { ...lineupOpts, horizon: cfg.horizon, discount: cfg.discount, mode: 'fast' };
  const lastGw = Math.min(gw + cfg.horizon - 1, projections.gwTo);

  const horizonValue = playerHorizonValues(projections, gw, lastGw, cfg.discount);
  const pools = buildPools({ players, projections, horizonValue, owned, picks, bankBefore, cfg, R });
  const doubts = ownedDoubts(picks, players);

  const baseClubCounts = new Map();
  for (const id of ownedIds) {
    const t = players.get(id).teamId;
    baseClubCounts.set(t, (baseClubCounts.get(t) || 0) + 1);
  }

  const candidates = [];
  const seen = new Set();

  const push = (outIds, inIds) => {
    const key = transferKey(outIds, inIds);
    if (seen.has(key)) return;

    const count = outIds.length;
    const acct = transferAccounting({ state: transferState, transfersMade: count, rules: R });
    if (acct.hits > cfg.maxHits) return;

    let moneyIn = 0;
    for (const id of outIds) moneyIn += owned.get(id).sellingTenths;
    let moneyOut = 0;
    for (const id of inIds) moneyOut += players.get(id).nowCost;
    const bankAfter = bankBefore + moneyIn - moneyOut;
    if (bankAfter < 0) return;

    if (!clubLimitOk(baseClubCounts, outIds, inIds, players, R.clubLimit)) return;

    seen.add(key);
    const squad = applyTransfers(ownedIds, outIds, inIds);
    candidates.push({
      key, outIds, inIds, squad,
      transferCount: count,
      freeTransfersUsed: acct.freeTransfersUsed,
      freeTransfersAfter: acct.freeTransfersAfter,
      freeTransfersNextGw: acct.freeTransfersNextGw,
      hits: acct.hits,
      hitCostPoints: acct.hitCostPoints,
      moneyIn, moneyOut, bankAfter,
      churnCost: churnCost(outIds, inIds, doubts, horizonValue, cfg),
    });
  };

  push([], []);

  if (cfg.maxTransfers >= 1) {
    for (const pick of picks) {
      const position = players.get(pick.playerId).position;
      const budget = bankBefore + pick.sellingTenths;
      for (const cand of pools.get(position) || []) {
        if (cand.nowCost > budget) continue;
        push([pick.playerId], [cand.id]);
      }
    }
  }

  if (cfg.maxTransfers >= 2 && freeTransfers + cfg.maxHits >= 2) {
    const outCandidates = chooseOutCandidates({ picks, players, horizonValue, pools, bankBefore, cfg });
    const pairPools = new Map();
    for (const [position, list] of pools) {
      pairPools.set(position, list.slice(0, cfg.pairPoolPerPosition));
    }
    for (let a = 0; a < outCandidates.length; a++) {
      for (let b = a + 1; b < outCandidates.length; b++) {
        const outA = outCandidates[a];
        const outB = outCandidates[b];
        const budget = bankBefore + outA.sellingTenths + outB.sellingTenths;
        const poolA = pairPools.get(players.get(outA.playerId).position) || [];
        const poolB = pairPools.get(players.get(outB.playerId).position) || [];
        for (const inA of poolA) {
          if (inA.nowCost > budget) continue;
          for (const inB of poolB) {
            if (inA.id === inB.id) continue;
            if (inA.nowCost + inB.nowCost > budget) continue;
            push([outA.playerId, outB.playerId], [inA.id, inB.id]);
          }
        }
      }
    }
  }

  // --- score: prune cheap, decide exact ------------------------------------
  //
  // The wide search ranks thousands of squads, so it ranks them with the fast
  // lineup objective. But the squad that gets recommended is PLAYED with the
  // exact one, and the two do not agree: the exact model will start a doubtful
  // player when a same-position substitute covers him, a move the fast model
  // cannot even represent. Ranking under one objective and playing under
  // another mis-ranks candidates at the only place it matters, the decision
  // boundary, so the shortlist is re-scored exactly before anything is chosen.
  //
  // The shortlist has to be wider than the number of alternatives returned,
  // because the whole point is that the exact ordering differs from the fast
  // one and a candidate outside the returned set can be promoted into it.

  // `churnCost` is a decision margin, not a points forecast, so it stays out of
  // `xPointsHorizon` for the same reason `hitMargin` does: the number shown to
  // a user has to remain what the engine actually expects to score.
  const score = (c) => {
    c.xPointsHorizon = c.horizonRaw - c.hitCostPoints;
    c.score = c.xPointsHorizon - cfg.hitMargin * c.hits + c.rollValue - c.churnCost;
  };

  for (const c of candidates) {
    const horizonResult = squadHorizonValue(c.squad, projections, gw, R, horizonOpts);
    c.horizonRaw = horizonResult.total;
    c.horizonByGw = horizonResult.byGw;
    c.rollValue = rollValue(c.freeTransfersNextGw, cfg);
    score(c);
  }

  const byScore = (x, y) => (y.score - x.score) || (x.transferCount - y.transferCount) || compareKeys(x.key, y.key);
  candidates.sort(byScore);

  const baseline = candidates.find(c => c.transferCount === 0);
  const shortlist = candidates.slice(0, Math.max(1, cfg.rerankCandidates));
  if (baseline && !shortlist.includes(baseline)) shortlist.push(baseline);

  const exactHorizonOpts = { ...horizonOpts, mode: 'exact' };
  for (const c of shortlist) {
    const horizonResult = squadHorizonValue(c.squad, projections, gw, R, exactHorizonOpts);
    c.horizonRaw = horizonResult.total;
    c.horizonByGw = horizonResult.byGw;
    score(c);
  }
  shortlist.sort(byScore);

  const top = shortlist.slice(0, Math.max(1, cfg.maxCandidates));
  if (baseline && !top.includes(baseline)) top.push(baseline);

  const out = [];
  for (const c of top) {
    const plan = finalizePlan(c, {
      gw, R, players, owned, projections, gameState, squadState,
      bankBefore, lineupOpts, cfg, baseline,
    });
    const validation = validatePlan(plan, squadState, gameState, R);
    if (!validation.ok) continue;
    plan.validation = validation;
    out.push(plan);
  }

  out.sort((x, y) => (y.score - x.score) || (x.transferCount - y.transferCount) || compareKeys(x.key, y.key));
  for (let i = 0; i < out.length; i++) out[i].rank = i + 1;
  return out;
}

// ---------------------------------------------------------------------------

function finalizePlan(c, ctx) {
  const { gw, R, players, owned, projections, gameState, bankBefore, lineupOpts, cfg, baseline } = ctx;

  const lineup = optimizeLineup(c.squad, projections, gw, R, lineupOpts);
  const captaincy = chooseCaptain(lineup.startingXI, projections, gw, gameState, { risk: cfg.risk });

  const captainProj = projections.get(captaincy.captain, gw);
  const captainSd = captainProj ? captainProj.sd : 0;
  // Doubling the captain turns his variance contribution from sigma^2 into
  // (2 sigma)^2, so three more copies of it join the eleven's variance.
  const variance = lineup.sd * lineup.sd + 3 * captainSd * captainSd;

  const xPointsGw = lineup.xPoints + lineup.autosubValue + captaincy.xPointsCaptaincy;

  let squadSellingValue = 0;
  for (const id of c.squad) {
    const pick = owned.get(id);
    squadSellingValue += pick ? pick.sellingTenths : players.get(id).nowCost;
  }

  return {
    key: c.key,
    gw,
    chip: null,
    transfersOut: c.outIds.slice(),
    transfersIn: c.inIds.slice(),
    transferCount: c.transferCount,
    freeTransfersUsed: c.freeTransfersUsed,
    freeTransfersAfter: c.freeTransfersAfter,
    freeTransfersNextGw: c.freeTransfersNextGw,
    hits: c.hits,
    hitCostPoints: c.hitCostPoints,
    bankBeforeTenths: bankBefore,
    moneyInTenths: c.moneyIn,
    moneyOutTenths: c.moneyOut,
    bankAfterTenths: c.bankAfter,
    squadValueAfterTenths: squadSellingValue + c.bankAfter,
    squad: c.squad.slice(),
    startingXI: lineup.startingXI,
    formation: lineup.formation,
    bench: lineup.bench,
    captain: captaincy.captain,
    viceCaptain: captaincy.viceCaptain,
    xPointsGw,
    xPointsNet: xPointsGw - c.hitCostPoints,
    xPointsHorizon: c.xPointsHorizon,
    sd: Math.sqrt(Math.max(0, variance)),
    score: c.score,
    rollValue: c.rollValue,
    churnCost: c.churnCost,
    horizonRaw: c.horizonRaw,
    horizonByGw: c.horizonByGw,
    horizonGainVsHold: baseline ? c.horizonRaw - baseline.horizonRaw : 0,
    scoreGainVsHold: baseline ? c.score - baseline.score : 0,
    captaincy,
    lineup: {
      xPoints: lineup.xPoints,
      autosubValue: lineup.autosubValue,
      benchXPoints: lineup.benchXPoints,
    },
    isRoll: c.transferCount === 0,
  };
}

// ---------------------------------------------------------------------------

function playerHorizonValues(projections, gwFrom, gwTo, discount) {
  const values = new Map();
  for (const id of projections.byPlayer.keys()) {
    let total = 0;
    for (let g = gwFrom, k = 0; g <= gwTo; g++, k++) {
      const proj = projections.get(id, g);
      if (proj) total += Math.pow(discount, k) * proj.xPoints;
    }
    values.set(id, total);
  }
  return values;
}

function buildPools({ players, projections, horizonValue, owned, picks, bankBefore, cfg, R }) {
  // The most cash one sale, and two sales, can free in each position.
  const sellingByPosition = new Map();
  for (const pick of picks) {
    const position = players.get(pick.playerId).position;
    if (!sellingByPosition.has(position)) sellingByPosition.set(position, []);
    sellingByPosition.get(position).push(pick.sellingTenths);
  }
  for (const list of sellingByPosition.values()) list.sort((a, b) => b - a);

  const byPosition = new Map();
  for (const id of projections.byPlayer.keys()) {
    const player = players.get(id);
    if (!player) continue;
    if (owned.has(id)) continue;
    if (UNBUYABLE_STATUSES.has(player.status)) continue;
    if (!byPosition.has(player.position)) byPosition.set(player.position, []);
    byPosition.get(player.position).push({
      id,
      nowCost: player.nowCost,
      teamId: player.teamId,
      value: horizonValue.get(id) || 0,
    });
  }

  const pools = new Map();
  for (const pos of Object.keys(R.positions).map(Number)) {
    const all = byPosition.get(pos) || [];
    const selling = sellingByPosition.get(pos) || [0];
    const band = bankBefore + (selling[0] || 0) + (selling[1] || 0);
    const affordable = all.filter(p => p.nowCost <= band);

    const byValue = affordable.slice().sort((a, b) => (b.value - a.value) || (a.id - b.id));
    const kept = byValue.slice(0, cfg.poolPerPosition);
    const keptIds = new Set(kept.map(p => p.id));

    const byPrice = affordable.slice().sort((a, b) => (a.nowCost - b.nowCost) || (b.value - a.value) || (a.id - b.id));
    for (const p of byPrice.slice(0, cfg.enablersPerPosition)) {
      if (!keptIds.has(p.id)) {
        kept.push(p);
        keptIds.add(p.id);
      }
    }

    kept.sort((a, b) => (b.value - a.value) || (a.id - b.id));
    pools.set(pos, kept);
  }
  return pools;
}

function chooseOutCandidates({ picks, players, horizonValue, pools, bankBefore, cfg }) {
  const rows = picks.map(pick => {
    const player = players.get(pick.playerId);
    const own = horizonValue.get(pick.playerId) || 0;
    const budget = bankBefore + pick.sellingTenths;
    let bestReplacement = 0;
    for (const cand of pools.get(player.position) || []) {
      if (cand.nowCost > budget) continue;
      if (cand.value > bestReplacement) bestReplacement = cand.value;
    }
    return {
      playerId: pick.playerId,
      sellingTenths: pick.sellingTenths,
      value: own,
      upgradeGain: bestReplacement - own,
      cashPerValue: pick.sellingTenths / Math.max(1, own),
    };
  });

  const byUpgrade = rows.slice().sort((a, b) => (b.upgradeGain - a.upgradeGain) || (a.playerId - b.playerId));
  const chosen = byUpgrade.slice(0, cfg.maxOutCandidates);
  const chosenIds = new Set(chosen.map(r => r.playerId));

  const byCash = rows.slice().sort((a, b) => (b.cashPerValue - a.cashPerValue) || (a.playerId - b.playerId));
  for (const r of byCash.slice(0, Math.ceil(cfg.maxOutCandidates / 2))) {
    if (!chosenIds.has(r.playerId)) {
      chosen.push(r);
      chosenIds.add(r.playerId);
    }
  }
  return chosen;
}

// A doubt is what is left of certainty, and only where certainty is genuinely
// in question: availability 1 is a fit player and availability 0 is a player
// the game has ruled out, and neither is a knee-jerk sale.
function ownedDoubts(picks, players) {
  const doubts = new Map();
  for (const pick of picks) {
    const player = players.get(pick.playerId);
    if (!player) continue;
    const { availability } = availabilityCeiling(player);
    if (availability > 0 && availability < 1) doubts.set(pick.playerId, 1 - availability);
  }
  return doubts;
}

// `outIds[i]` and `inIds[i]` are the same swap: every candidate is built by
// pairing an outgoing player with a replacement drawn from HIS position's pool,
// so the arrays are index aligned by construction.
function churnCost(outIds, inIds, doubts, horizonValue, cfg) {
  if (!cfg.retentionCredit || !outIds.length || !doubts.size) return 0;
  let total = 0;
  for (let i = 0; i < outIds.length; i++) {
    const doubt = doubts.get(outIds[i]);
    if (!doubt) continue;
    const gain = (horizonValue.get(inIds[i]) || 0) - (horizonValue.get(outIds[i]) || 0);
    if (gain > 0) total += cfg.retentionCredit * doubt * gain;
  }
  return total;
}

// `carried` is what next gameweek actually starts with, from transfer-state.js.
// One of those transfers arrives free whatever this week's candidate does, so
// only the ones beyond it are worth anything as an option on a future move, and
// the difference between candidates correctly falls to zero at the cap.
function rollValue(carried, cfg) {
  return cfg.ftValuePoints * Math.max(0, carried - 1);
}

function clubLimitOk(baseCounts, outIds, inIds, players, limit) {
  const counts = new Map(baseCounts);
  for (const id of outIds) {
    const t = players.get(id).teamId;
    counts.set(t, counts.get(t) - 1);
  }
  for (const id of inIds) {
    const t = players.get(id).teamId;
    const n = (counts.get(t) || 0) + 1;
    if (n > limit) return false;
    counts.set(t, n);
  }
  return true;
}

function applyTransfers(ownedIds, outIds, inIds) {
  const outSet = new Set(outIds);
  const squad = ownedIds.filter(id => !outSet.has(id));
  for (const id of inIds) squad.push(id);
  return squad;
}

function transferKey(outIds, inIds) {
  return `${outIds.slice().sort((a, b) => a - b).join(',')}>${inIds.slice().sort((a, b) => a - b).join(',')}`;
}

function compareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
