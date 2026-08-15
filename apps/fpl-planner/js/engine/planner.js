// The planner: one gameweek's concrete recommendation, plus the projected plan
// for the gameweeks after it.
//
// This is the single entry point the UI calls. Everything else in the engine is
// a component it assembles: strength, fixtures, minutes and projections build
// the world, lineup, captain, transfers, squad-builder and chips propose moves,
// validate.js gates the result and explain.js narrates it from the same numbers
// the optimizer used.
//
// WHY A HORIZON AND NOT A GAMEWEEK
//
// Single gameweek optimization makes locally sensible and globally bad moves:
// it will sell a player with one awkward fixture and five excellent ones for a
// player with the reverse, and it will spend a free transfer every week because
// this week's small upgrade always looks free. Both are avoided the same way,
// by scoring every candidate over a rolling horizon with the later gameweeks
// discounted for uncertainty, and by giving a banked free transfer an explicit
// points value so that doing nothing has to be beaten rather than assumed.
//
// THE DISCOUNT IS UNCERTAINTY, NOT IMPATIENCE
//
// A projection four gameweeks out is worth less than the one for this Saturday,
// because injuries, rotation, price changes and fixture reschedules have four
// more weeks to happen. `discount` is that decay, applied as discount^k to the
// gameweek k weeks ahead. It is a named parameter, it is reported in
// `dataStatus`, and the risk profiles move it.
//
// PRE-SEASON
//
// When `squadState.source === 'draft'` there is no squad to transfer from, so
// the plan is not a transfer plan: it is a full opening 15 built by the same
// optimizer the wildcard uses. It is still a Plan and it still passes
// validate.js, so nothing downstream needs a second code path.

import { buildStrength } from './strength.js';
import { buildProjections } from './projections.js';
import { optimizeLineup } from './lineup.js';
import { chooseCaptain } from './captain.js';
import { searchTransfers } from './transfers.js';
import { buildSquad } from './squad-builder.js';
import { validatePlan } from './validate.js';
import { evaluateChips, squadTrajectory, discountWeights, xpOf, chipLabel } from './chips.js';
import { explainPlan } from './explain.js';
import { advance, transferAccounting, transferStateOf, freeTransfersFor } from './transfer-state.js';
import { seasonEvidence } from './minutes.js';

export const PLANNER_VERSION = 'planner-1';

// ---------------------------------------------------------------------------
// Risk profiles.
//
// The default has to be intelligent with no configuration at all, so
// `balanced` is the model's honest optimum: hits only when they clearly pay,
// one week of aggression at most, and a banked transfer valued at roughly what
// a free transfer returns in a normal week. The other two profiles move four
// named knobs and nothing else, which is what makes the difference testable.
//
//   hitMarginPoints    extra discounted horizon points a plan taking a hit must
//                      beat the best free plan by, on top of the 4 point cost
//   maxHits            cap on transfers beyond the free ones
//   variancePreference weight on this gameweek's standard deviation. Positive
//                      buys upside, negative buys a floor, zero is indifferent
//   discount           per gameweek uncertainty decay across the horizon
//   rollBonus          points value of one banked free transfer
// ---------------------------------------------------------------------------

export const RISK_PROFILES = Object.freeze({
  balanced: Object.freeze({
    hitMarginPoints: 2.0, maxHits: 1, variancePreference: 0, discount: 0.85, rollBonus: 0.6,
  }),
  aggressive: Object.freeze({
    hitMarginPoints: 0.5, maxHits: 2, variancePreference: 0.25, discount: 0.9, rollBonus: 0.2,
  }),
  conservative: Object.freeze({
    hitMarginPoints: 4.0, maxHits: 0, variancePreference: -0.2, discount: 0.8, rollBonus: 1.2,
  }),
});

// The default horizon is 5, and it is 5 because of a measurement, not a taste.
//
// It was 3 from 2026-08-10 to 2026-08-12, on evidence that has since been
// withdrawn. That evidence was nine chip-free windows read at one seed, on a
// replay whose start-rate denominator excluded the previous season it had just
// seeded, so pStart was pinned at 1.000 for most of the owned pool for half of
// every replayed season (experiments/replay-evidence.md). The reasoning also
// rested on projection bias, and it named its own re-test condition: "if
// projection calibration improves, re-run the sweep". Correcting the evidence
// moved the bias from about zero to -7 points a gameweek, which fired it.
//
// Re-measured on 45 paired trajectories read as 15 windows, chips off, which is
// the instrument experiments/registry.md treats as deciding:
//
//   arm          per-window mean   t      W-L-T    2022-23   2023-24   2024-25
//   horizon 5    +21.6             2.32   11-4-0   +16       +546      +409
//   horizon 8    +17.7             1.28    9-6-0   +44       +394      +357
//
// Both beat horizon 3 and 5 beats 8, so the answer is an interior optimum
// rather than "longer is always better". Positive in all three seasons, which
// is the consistency test this project requires of an aggregate.
//
// Over the full 38 gameweeks WITH chips, one seed, horizon 5 reads 2209 / 2208
// / 2453 against 2247 / 2229 / 2328, a total of +66 that loses two seasons of
// three. That is the weakest instrument in the file and it disagrees with
// itself: one forked chip cascades through everything after it, and those
// replays also run on the 2025-26 chip catalogue, which gives those seasons
// three chips they did not have. It is reported because it was measured, not
// because it decides.
//
// Reproduce with `node apps/fpl-planner/scripts/experiment.mjs --config
// apps/fpl-planner/experiments/configs/horizon.mjs`, about twenty minutes on
// eight workers. Registry entry 9.
//
// The horizon stays user configurable in Settings (3, 5 or 8). This is only what
// a manager gets before they choose. `js/ui/store.js` and `js/engine/lineup.js`
// carry the same number and a test asserts all three agree.
const DEFAULT_HORIZON = 5;

// How many ranked alternatives the UI is offered below the primary pick.
const MAX_ALTERNATIVES = 3;

// Data older than this is called out in dataStatus. It is not an error and the
// plan is still produced: FPL prices and news move daily, not hourly.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export const PLANNER_PARAMS = Object.freeze({
  defaultHorizon: DEFAULT_HORIZON,
  maxAlternatives: MAX_ALTERNATIVES,
  staleAfterMs: STALE_AFTER_MS,
  riskProfiles: RISK_PROFILES,
});

export const PROGRESS_STAGES = Object.freeze([
  { key: 'load-team', label: 'Loading your FPL team', pct: 0.08 },
  { key: 'analyze-players', label: 'Analyzing players', pct: 0.28 },
  { key: 'project-fixtures', label: 'Projecting fixtures', pct: 0.55 },
  { key: 'optimize-transfers', label: 'Optimizing transfers', pct: 0.82 },
  { key: 'build-plan', label: 'Building your Gameweek plan', pct: 1 },
]);

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// ---------------------------------------------------------------------------

function resolveOptions(options, rules, gw) {
  const risk = RISK_PROFILES[options.risk] ? options.risk : 'balanced';
  const profile = RISK_PROFILES[risk];
  const requested = options.horizon || DEFAULT_HORIZON;
  const remaining = Math.max(1, rules.totalEvents - gw + 1);
  return {
    risk,
    profile,
    horizon: Math.max(1, Math.min(requested, remaining)),
    requestedHorizon: requested,
    discount: options.discount === undefined ? profile.discount : options.discount,
    maxHits: options.maxHits === undefined ? profile.maxHits : options.maxHits,
    hitMarginPoints: options.hitMarginPoints === undefined ? profile.hitMarginPoints : options.hitMarginPoints,
    variancePreference: options.variancePreference === undefined ? profile.variancePreference : options.variancePreference,
    rollBonus: options.rollBonus === undefined ? profile.rollBonus : options.rollBonus,
    seed: options.seed === undefined ? 1 : options.seed,
    futureTransfers: options.futureTransfers !== false,
    projections: options.projections || null,
    strength: options.strength || null,
    model: options.model || null,
    dataVersion: options.dataVersion || null,
    sample: options.sample === undefined ? null : options.sample,
    maxCandidates: options.maxCandidates || 40,
  };
}

// The value of the free transfers the manager will actually START next gameweek
// with. `acct.freeTransfersNextGw` comes from transfer-state.js, so the cap, the
// chip weeks and the pre-season transition are applied once: the marginal value
// of the last one at the cap is correctly zero, because a transfer you cannot
// bank is worth nothing.
function bankedTransferValue(acct, rollBonus) {
  return rollBonus * acct.freeTransfersNextGw;
}

function emit(onProgress, key) {
  if (typeof onProgress !== 'function') return;
  const stage = PROGRESS_STAGES.find(s => s.key === key);
  onProgress({ key: stage.key, label: stage.label, pct: stage.pct });
}

// Lets a worker paint between stages instead of blocking for the whole run.
const yieldToHost = () => new Promise(resolve => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Transfer candidates
// ---------------------------------------------------------------------------

function currentSquadIds(squadState) {
  return squadState.picks.map(p => p.playerId);
}

function sellingMap(squadState) {
  const m = new Map();
  for (const p of squadState.picks) m.set(p.playerId, p.sellingTenths);
  return m;
}

// searchTransfers returns candidate plans. Its exact field names are its own
// business: everything the planner needs is recomputed here from the squad it
// implies, so the plan's arithmetic is internally consistent whatever the
// search called its fields.
function normalizeCandidate(raw, { squadState, rules }) {
  const out = raw.transfersOut || raw.out || [];
  const inn = raw.transfersIn || raw.in || [];
  const held = currentSquadIds(squadState);
  const selling = sellingMap(squadState);

  const squad = raw.squad && raw.squad.length === rules.squadSize
    ? raw.squad.slice()
    : held.filter(id => !out.includes(id)).concat(inn);

  if (squad.length !== rules.squadSize) return null;
  if (new Set(squad).size !== squad.length) return null;
  if (out.some(id => !selling.has(id))) return null;

  return {
    transfersOut: out.slice(),
    transfersIn: inn.slice(),
    squad,
    source: raw,
  };
}

function priceOf(gameState, playerId) {
  const p = gameState.players.get(playerId);
  return p ? p.nowCost : 0;
}

function candidateMoney(candidate, { squadState, gameState }) {
  const selling = sellingMap(squadState);
  const moneyInTenths = candidate.transfersOut.reduce((s, id) => s + (selling.get(id) || 0), 0);
  const moneyOutTenths = candidate.transfersIn.reduce((s, id) => s + priceOf(gameState, id), 0);
  const bankBeforeTenths = squadState.bankTenths;
  return {
    bankBeforeTenths,
    moneyInTenths,
    moneyOutTenths,
    bankAfterTenths: bankBeforeTenths + moneyInTenths - moneyOutTenths,
  };
}

// ---------------------------------------------------------------------------
// Scoring one candidate over the horizon
// ---------------------------------------------------------------------------

function scoreCandidate({
  candidate, chip, squadState, projections, gameState, rules, cfg, gw,
}) {
  const money = candidateMoney(candidate, { squadState, gameState });
  if (money.bankAfterTenths < 0) return null;

  const count = candidate.transfersIn.length;
  const acct = transferAccounting({
    state: transferStateOf(squadState, rules), transfersMade: count, chipPlayed: chip, rules,
  });
  if (acct.hits > cfg.maxHits) return null;

  const trajectory = squadTrajectory({
    squadIds: candidate.squad,
    projections, gameState, rules,
    gwFrom: gw,
    horizon: cfg.horizon,
    discount: cfg.discount,
    opts: { seed: cfg.seed },
  });

  const first = trajectory.gws[0];
  const chipBonus = chip === 'bboost'
    ? first.xPointsBench
    : chip === '3xc'
      ? first.captainExtra
      : 0;

  const horizonPoints = trajectory.total + chipBonus - acct.hitCostPoints;
  const objective = horizonPoints
    + bankedTransferValue(acct, cfg.rollBonus)
    + cfg.variancePreference * first.sd;

  return {
    candidate, chip, money, acct, trajectory, chipBonus,
    xPointsGw: first.xPoints + chipBonus,
    xPointsNet: first.xPoints + chipBonus - acct.hitCostPoints,
    xPointsHorizon: horizonPoints,
    objective,
    transferCount: count,
  };
}

// ---------------------------------------------------------------------------
// Assembling a Plan
// ---------------------------------------------------------------------------

function planFromScored(scored, { squadState, gameState, rules, cfg, gw, certainty, baseGw }) {
  const first = scored.trajectory.gws[0];
  const squadValueAfterTenths = scored.candidate.squad.reduce((s, id) => s + priceOf(gameState, id), 0)
    + scored.money.bankAfterTenths;

  return {
    gw,
    chip: scored.chip,
    transfersOut: scored.candidate.transfersOut.slice(),
    transfersIn: scored.candidate.transfersIn.slice(),
    transferCount: scored.transferCount,
    freeTransfersUsed: scored.acct.freeTransfersUsed,
    freeTransfersAfter: scored.acct.freeTransfersAfter,
    // What next gameweek actually starts with. Carried on the plan because it is
    // the number every "you go into next week with" sentence needs, and a caller
    // adding one to `freeTransfersAfter` is a caller reimplementing the cap.
    freeTransfersNextGw: scored.acct.freeTransfersNextGw,
    hits: scored.acct.hits,
    hitCostPoints: scored.acct.hitCostPoints,
    bankBeforeTenths: scored.money.bankBeforeTenths,
    moneyInTenths: scored.money.moneyInTenths,
    moneyOutTenths: scored.money.moneyOutTenths,
    bankAfterTenths: scored.money.bankAfterTenths,
    squadValueAfterTenths,
    squad: scored.candidate.squad.slice(),
    startingXI: first.startingXI.slice(),
    formation: first.formation,
    bench: { gk: first.bench.gk, order: first.bench.order.slice() },
    captain: first.captain,
    viceCaptain: first.viceCaptain,
    xPointsGw: scored.xPointsGw,
    xPointsNet: scored.xPointsNet,
    xPointsHorizon: scored.xPointsHorizon,
    sd: first.sd,
    certainty: certainty || 'current',
    // How much less certain a projected gameweek is than this one. Measured
    // from the gameweek being planned FOR, not from the squad state the
    // projection inherits: a projected state carries the future gameweek in
    // `gw`, so measuring against it would report every future plan as fully
    // certain.
    confidence: certainty === 'projected' ? Math.pow(cfg.discount, gw - (baseGw ?? squadState.gw)) : 1,
    explanation: null,
    alternatives: [],
    computedAt: new Date().toISOString(),
    modelVersion: `${PLANNER_VERSION}+${cfg.projectionModelVersion || 'unknown'}`,
    horizon: cfg.horizon,
    durationMs: 0,
  };
}

function alternativeFrom(scored, primary, gameState) {
  return {
    chip: scored.chip,
    transfersOut: scored.candidate.transfersOut.slice(),
    transfersIn: scored.candidate.transfersIn.slice(),
    transferCount: scored.transferCount,
    hits: scored.acct.hits,
    hitCostPoints: scored.acct.hitCostPoints,
    bankAfterTenths: scored.money.bankAfterTenths,
    xPointsGw: scored.xPointsGw,
    xPointsHorizon: scored.xPointsHorizon,
    deltaHorizon: scored.xPointsHorizon - primary.xPointsHorizon,
    headline: alternativeHeadline(scored, gameState),
  };
}

function alternativeHeadline(scored, gameState) {
  const name = id => {
    const p = gameState.players.get(id);
    return p ? p.webName : `player ${id}`;
  };
  if (scored.chip) return `Play your ${chipLabel(scored.chip)}`;
  if (!scored.transferCount) return 'Roll your transfer';
  const pairs = scored.candidate.transfersOut.map((out, i) => `${name(out)} to ${name(scored.candidate.transfersIn[i])}`);
  const hitNote = scored.acct.hits ? ` (-${scored.acct.hitCostPoints})` : '';
  return `${pairs.join(', ')}${hitNote}`;
}

// ---------------------------------------------------------------------------
// The draft (pre-season) plan: no squad to transfer from, so the recommendation
// is the opening 15 itself.
// ---------------------------------------------------------------------------

function buildDraftPlan({ squadState, projections, gameState, rules, cfg, gw }) {
  const built = buildSquad({
    projections, gameState, rules, gw,
    horizon: cfg.horizon,
    budgetTenths: rules.budgetTenths,
    opts: { discount: cfg.discount, seed: cfg.seed },
  });

  const trajectory = squadTrajectory({
    squadIds: built.squad, projections, gameState, rules,
    gwFrom: gw, horizon: cfg.horizon, discount: cfg.discount, opts: { seed: cfg.seed },
  });

  const costTenths = built.squad.reduce((s, id) => s + priceOf(gameState, id), 0);
  const scored = {
    candidate: { transfersOut: [], transfersIn: [], squad: built.squad.slice() },
    chip: null,
    money: {
      bankBeforeTenths: rules.budgetTenths,
      moneyInTenths: 0,
      moneyOutTenths: costTenths,
      bankAfterTenths: rules.budgetTenths - costTenths,
    },
    acct: transferAccounting({
      state: transferStateOf(squadState, rules), transfersMade: 0, chipPlayed: null, rules,
    }),
    trajectory,
    chipBonus: 0,
    xPointsGw: trajectory.gws[0].xPoints,
    xPointsNet: trajectory.gws[0].xPoints,
    xPointsHorizon: trajectory.total,
    objective: trajectory.total,
    transferCount: 0,
  };
  return { scored, built };
}

// ---------------------------------------------------------------------------
// Projected future plans.
//
// These are marked less certain and they are honest about why: they assume the
// squad they inherit, one new free transfer per gameweek, and projections that
// decay by `discount` per week. They exist so a manager can see that this
// week's roll is paid back next week, not so they can be executed blind.
// ---------------------------------------------------------------------------

function projectedSquadState(prevPlan, prevState, rules, gw, chipPlayed, gameState) {
  const chipsUsed = chipPlayed
    ? [...(prevState.chipsUsed || []), { name: chipPlayed, event: prevPlan.gw }]
    : (prevState.chipsUsed || []);

  // A free hit hands the squad back at the end of the gameweek, so the week
  // after it starts from the squad the manager owned before playing it.
  const revert = prevPlan.chip === 'freehit';
  const squad = revert ? prevState.picks.map(p => p.playerId) : prevPlan.squad;
  const bank = revert ? prevState.bankTenths : prevPlan.bankAfterTenths;

  const sellingBefore = new Map(prevState.picks.map(p => [p.playerId, p.sellingTenths]));
  const picks = squad.map((playerId, idx) => ({
    playerId,
    slot: idx + 1,
    isCaptain: false,
    isViceCaptain: false,
    multiplier: 1,
    // A player bought this gameweek is worth what was paid for him next
    // gameweek, and a player already held keeps the selling price we
    // reconstructed. Price rises inside the horizon are not projected: guessing
    // them would move affordability, and a plan that cannot be executed is the
    // failure this app exists to avoid. Leaving a new signing at null instead
    // (which is what this did) makes him worth ZERO to sell in every later
    // gameweek of the horizon, so the projected plan cannot fund a move by
    // selling him and understates the squad's value.
    purchaseTenths: sellingBefore.get(playerId) ?? priceOf(gameState, playerId),
    sellingTenths: sellingBefore.get(playerId) ?? priceOf(gameState, playerId),
  }));

  // One gameweek of the real transition: what was spent this week, whether a
  // chip made it free, then next week's arrival, capped.
  const transferState = advance(transferStateOf(prevState, rules), {
    gw: prevPlan.gw,
    transfersMade: prevPlan.transferCount || 0,
    chipPlayed: prevPlan.chip || null,
    rules,
  });

  return {
    ...prevState,
    gw,
    picks,
    bankTenths: bank,
    transferState,
    freeTransfers: freeTransfersFor(transferState),
    chipsUsed,
    projected: true,
  };
}

// ---------------------------------------------------------------------------

export async function buildPlan({ gameState, squadState, options = {}, onProgress = null }) {
  const started = nowMs();
  const rules = gameState.rules;
  const gw = squadState.gw ?? gameState.nextEvent ?? gameState.currentEvent ?? 1;
  const cfg = resolveOptions(options, rules, gw);
  const isDraft = squadState.source === 'draft' || squadState.picks.length === 0;

  emit(onProgress, 'load-team');
  // Real work for this stage: resolve the horizon against the calendar, fill in
  // selling prices for a squad state that arrived without them, and settle the
  // chip ledger the rest of the run reads.
  const workingSquad = {
    ...squadState,
    gw,
    picks: squadState.picks.map(p => ({
      ...p,
      sellingTenths: p.sellingTenths === null || p.sellingTenths === undefined
        ? priceOf(gameState, p.playerId)
        : p.sellingTenths,
    })),
    chipsUsed: squadState.chipsUsed || [],
  };
  // A squad state that arrived without one (a hand-built squad, a stored
  // fixture) is read into a state here rather than defaulted to a bare number
  // that later code would do its own arithmetic on.
  workingSquad.transferState = transferStateOf(workingSquad, rules);
  workingSquad.freeTransfers = freeTransfersFor(workingSquad.transferState);
  await yieldToHost();

  emit(onProgress, 'analyze-players');
  const strength = cfg.strength || buildStrength(gameState, { asOfGw: gw });
  await yieldToHost();

  emit(onProgress, 'project-fixtures');
  const gwTo = gw + cfg.horizon - 1;
  const projections = cfg.projections || buildProjections({
    gameState, strength, gwFrom: gw, gwTo, model: cfg.model,
  });
  cfg.projectionModelVersion = projections.modelVersion;
  await yieldToHost();

  emit(onProgress, 'optimize-transfers');

  let primary;
  let alternatives = [];
  let chipEvaluation = null;
  let scoredList = [];

  if (isDraft) {
    const draft = buildDraftPlan({ squadState: workingSquad, projections, gameState, rules, cfg, gw });
    primary = draft.scored;
  } else {
    chipEvaluation = evaluateChips({
      squadState: workingSquad, projections, gameState, rules,
      horizon: cfg.horizon, discount: cfg.discount, opts: { seed: cfg.seed },
    });

    const raw = searchTransfers({
      squadState: workingSquad, projections, gameState, rules,
      horizon: cfg.horizon,
      opts: {
        discount: cfg.discount,
        maxHits: cfg.maxHits,
        maxCandidates: cfg.maxCandidates,
        seed: cfg.seed,
      },
    }) || [];

    // The roll is always on the table, whatever the search returned. It is the
    // baseline every other candidate has to beat, and it is a real answer, not
    // the absence of one.
    const candidates = [{ transfersOut: [], transfersIn: [], squad: currentSquadIds(workingSquad) }];
    for (const r of raw) {
      const c = normalizeCandidate(r, { squadState: workingSquad, rules });
      if (!c) continue;
      if (!c.transfersIn.length) continue;
      if (c.transfersIn.length !== c.transfersOut.length) continue;
      candidates.push(c);
    }

    scoredList = candidates
      .map(c => scoreCandidate({
        candidate: c, chip: null, squadState: workingSquad, projections, gameState, rules, cfg, gw,
      }))
      .filter(Boolean);

    // A chip plan is scored on the same scale as a transfer plan, so a wildcard
    // and a one transfer upgrade are compared with one number rather than by
    // rule.
    const chipScored = chipCandidates({
      chipEvaluation, squadState: workingSquad, projections, gameState, rules, cfg, gw,
    });
    scoredList = scoredList.concat(chipScored);

    scoredList.sort((a, b) => b.objective - a.objective);

    // Hits must clear the free plan by the profile's margin ON TOP of the four
    // points they already cost, so a marginal upgrade cannot buy its way in.
    const bestFree = scoredList.find(s => s.acct.hits === 0);
    primary = scoredList.find(s => {
      if (s.acct.hits === 0) return true;
      if (!bestFree) return true;
      return s.objective >= bestFree.objective + cfg.hitMarginPoints;
    }) || scoredList[0];

    alternatives = scoredList
      .filter(s => s !== primary)
      .slice(0, MAX_ALTERNATIVES);
  }

  await yieldToHost();
  emit(onProgress, 'build-plan');

  const plan = planFromScored(primary, { squadState: workingSquad, gameState, rules, cfg, gw, certainty: 'current' });
  plan.alternatives = alternatives.map(s => alternativeFrom(s, plan, gameState));

  const explainContext = {
    squadState: workingSquad,
    projections,
    gameState,
    rules,
    horizon: cfg.horizon,
    discount: cfg.discount,
    risk: cfg.risk,
    rollBonus: cfg.rollBonus,
    hitMarginPoints: cfg.hitMarginPoints,
    trajectory: primary.trajectory,
    chipEvaluation,
    scored: primary,
    scoredList,
    isDraft,
    rollValue: bankedTransferValue(primary.acct, cfg.rollBonus),
  };
  plan.explanation = explainPlan(plan, explainContext);

  const future = buildFuturePlans({
    plan, squadState: workingSquad, projections, gameState, rules, cfg, gw, chipEvaluation,
  });

  const violations = [];
  const currentCheck = validatePlan(plan, workingSquad, gameState, rules);
  if (!currentCheck.ok) violations.push(...currentCheck.violations.map(v => ({ ...v, gw: plan.gw })));
  for (const f of future) {
    const check = validatePlan(f.plan, f.squadState, gameState, rules);
    if (!check.ok) violations.push(...check.violations.map(v => ({ ...v, gw: f.plan.gw })));
  }
  if (violations.length) {
    const detail = violations.map(v => `${v.code}: ${v.message}`).join('; ');
    throw new Error(`planner: refusing to return an invalid plan (${detail})`);
  }

  const durationMs = nowMs() - started;
  plan.durationMs = durationMs;
  for (const f of future) f.plan.durationMs = durationMs;

  return {
    current: plan,
    future: future.map(f => f.plan),
    squadState: workingSquad,
    projections,
    chipEvaluation,
    dataStatus: buildDataStatus({ gameState, squadState: workingSquad, cfg, projections, durationMs }),
    validation: { ok: true, violations: [] },
  };
}

// ---------------------------------------------------------------------------

function chipCandidates({ chipEvaluation, squadState, projections, gameState, rules, cfg, gw }) {
  if (!chipEvaluation || !chipEvaluation.perChip) return [];
  const held = currentSquadIds(squadState);
  const out = [];

  for (const entry of Object.values(chipEvaluation.perChip)) {
    if (!entry.available) continue;

    let candidate;
    if (entry.chip === 'wildcard' || entry.chip === 'freehit') {
      const squad = entry.detail && entry.detail.squad;
      if (!squad || squad.length !== rules.squadSize) continue;
      candidate = {
        transfersOut: held.filter(id => !squad.includes(id)),
        transfersIn: squad.filter(id => !held.includes(id)),
        squad: squad.slice(),
      };
    } else {
      candidate = { transfersOut: [], transfersIn: [], squad: held.slice() };
    }

    const scored = scoreCandidate({
      candidate, chip: entry.chip, squadState, projections, gameState, rules, cfg, gw,
    });
    if (!scored) continue;

    // A chip is only offered when its own evaluator recommended it. Scoring it
    // anyway would let a chip win by a tenth of a point in a week it should be
    // saved for, which is exactly the mistake chips.js exists to prevent.
    if (!entry.recommended) continue;
    out.push(scored);
  }
  return out;
}

function buildFuturePlans({ plan, squadState, projections, gameState, rules, cfg, gw, chipEvaluation }) {
  const future = [];
  let prevPlan = plan;
  let prevState = squadState;

  for (let k = 1; k < cfg.horizon; k++) {
    const futureGw = gw + k;
    const state = projectedSquadState(prevPlan, prevState, rules, futureGw, prevPlan.chip, gameState);
    const remaining = cfg.horizon - k;
    const futureCfg = { ...cfg, horizon: remaining };

    const held = currentSquadIds(state);
    let candidates = [{ transfersOut: [], transfersIn: [], squad: held }];

    if (cfg.futureTransfers) {
      const raw = searchTransfers({
        squadState: state, projections, gameState, rules,
        horizon: remaining,
        opts: {
          discount: cfg.discount,
          maxHits: 0,
          maxCandidates: Math.max(8, Math.round(cfg.maxCandidates / 4)),
          seed: cfg.seed,
        },
      }) || [];
      for (const r of raw) {
        const c = normalizeCandidate(r, { squadState: state, rules });
        if (!c || !c.transfersIn.length) continue;
        if (c.transfersIn.length !== c.transfersOut.length) continue;
        candidates.push(c);
      }
    }

    const scored = candidates
      .map(c => scoreCandidate({
        candidate: c, chip: null, squadState: state, projections, gameState, rules,
        cfg: futureCfg, gw: futureGw,
      }))
      .filter(Boolean)
      .sort((a, b) => b.objective - a.objective);

    if (!scored.length) break;

    const best = scored.find(s => s.acct.hits === 0) || scored[0];
    const futurePlan = planFromScored(best, {
      squadState: state, gameState, rules, cfg: futureCfg, gw: futureGw, certainty: 'projected', baseGw: gw,
    });
    futurePlan.horizon = remaining;
    futurePlan.explanation = explainPlan(futurePlan, {
      squadState: state,
      projections, gameState, rules,
      horizon: remaining,
      discount: cfg.discount,
      risk: cfg.risk,
      rollBonus: cfg.rollBonus,
      hitMarginPoints: cfg.hitMarginPoints,
      trajectory: best.trajectory,
      chipEvaluation: null,
      scored: best,
      scoredList: scored,
      isDraft: false,
      projected: true,
      rollValue: bankedTransferValue(best.acct, cfg.rollBonus),
    });

    future.push({ plan: futurePlan, squadState: state });
    prevPlan = futurePlan;
    prevState = state;
  }

  return future;
}

function buildDataStatus({ gameState, squadState, cfg, projections, durationMs }) {
  const fetchedAt = gameState.fetchedAt || null;
  const ageMs = fetchedAt ? Date.now() - Date.parse(fetchedAt) : 0;
  // Staleness is about the AGE OF THE DATA and nothing else.
  //
  // Squad warnings used to be folded in here, so a reconstruction disagreeing
  // with FPL's frozen squad value (which happens on any overnight price move)
  // was reported to the user as "Working from older data". The data was not
  // old; the two numbers described different moments. They travel separately
  // now, and the status card already renders squadState.warnings on their own.
  const staleReasonCodes = [];
  if (fetchedAt && ageMs > STALE_AFTER_MS) staleReasonCodes.push('data_age');

  // Which season the element totals belong to, and whether there is anything to
  // project from at all. It travels with the plan because the UI has to be able
  // to refuse to present a recommendation built on no evidence, and because
  // "why does this look wrong" is answerable only if the state is reported.
  const evidence = seasonEvidence(gameState);

  return {
    fetchedAt,
    planComputedAt: new Date().toISOString(),
    stale: staleReasonCodes.length > 0,
    staleReasonCodes,
    squadWarnings: (squadState.warnings || []).map(w => ({ code: w.code, message: w.message })),
    evidence,
    sources: [
      {
        name: 'bootstrap-static',
        ok: gameState.players.size > 0,
        fetchedAt,
        ageSeconds: fetchedAt ? Math.max(0, Math.round(ageMs / 1000)) : null,
        error: null,
      },
      {
        name: 'fixtures',
        ok: gameState.fixtures.length > 0,
        fetchedAt,
        ageSeconds: fetchedAt ? Math.max(0, Math.round(ageMs / 1000)) : null,
        error: null,
      },
      {
        name: 'squad',
        ok: squadState.picks.length > 0 || squadState.source === 'draft',
        fetchedAt: squadState.asOf || null,
        ageSeconds: squadState.asOf ? Math.max(0, Math.round((Date.now() - Date.parse(squadState.asOf)) / 1000)) : null,
        error: null,
      },
    ],
    modelVersion: `${PLANNER_VERSION}+${projections.modelVersion}`,
    dataVersion: cfg.dataVersion || fetchedAt,
    horizon: cfg.horizon,
    // The uncertainty discount is a model parameter a user is entitled to see,
    // so it travels with the status rather than living only in the code.
    discount: cfg.discount,
    risk: cfg.risk,
    seed: cfg.seed,
    durationMs,
    // Sample mode has to be detectable from the plan alone, because every
    // surface that renders a number also has to label where it came from. The
    // flag rides in on the bootstrap (data/sample.js stamps it), through
    // buildGameState, and an explicit options.sample can still force it.
    sample: cfg.sample === null
      ? (gameState.sample === true || squadState.source === 'sample')
      : !!cfg.sample,
  };
}

// Exported for the backtest harness and the explanation layer, which both need
// to weigh a horizon exactly the way the planner did.
export { discountWeights, bankedTransferValue, xpOf };
