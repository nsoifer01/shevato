// How much to trust one plan, in three honest bands.
//
// WHY NOT A PERCENTAGE
//
// A number like "83% confident" implies a calibrated posterior over "was this
// the right transfer", and nothing in this engine measures that. What the
// engine does measure is a handful of real quantities that make a
// recommendation firmer or shakier, and each of them is legible on its own. So
// the output is one of three bands plus the sentence that earned it. A band
// with no stated reason would be worse than no band at all, so `reason` is
// never empty: when nothing is wrong, it says what is right.
//
// THE FIVE INPUTS, all already computed elsewhere:
//
//   minutes       projections carry `pStart` and the minutes model's own
//                 `confidence` label. What matters is not how many players are
//                 uncertain but how much of the gameweek's projected points
//                 sits on them, so this factor is a SHARE, not a count.
//   availability  `status` and `chanceNext` on the players the plan fields.
//                 An injury flag is a fact about the input, not a projection,
//                 which is why it outranks everything else here.
//   reach         a plan for this Saturday is a firmer claim than a projection
//                 three gameweeks out. planner.js already carries that as
//                 `plan.confidence` (discount^k), so this factor reads it
//                 rather than inventing a second decay. A projected gameweek
//                 can never reach the top band.
//   data          `dataStatus` carries fetchedAt, staleness and the per-source
//                 result. A plan built on a source that failed is a different
//                 claim from one built on a complete refresh.
//   margin        every projection carries `sd`. If the runner-up plan is
//                 closer than the week-to-week swing on the players the two
//                 plans disagree about, then the choice between them is
//                 genuinely close, and saying so is more useful than pretending
//                 a tenth of a point settled it.
//
// Each factor scores 0, 1 or 2 (reach can reach 4, because distance into the
// future is the one input that can make a plan untrustworthy on its own). The
// total picks the band. That is deliberately crude: the bands are meant to be
// reproducible and explainable, not finely tuned.

import { makeReason } from './chips.js';

export const CONFIDENCE_PARAMS = Object.freeze({
  // Below this start probability a player's minutes are "unclear" even when the
  // minutes model is confident about the number itself.
  unclearStartProbability: 0.65,
  // Share of the gameweek's projected points sitting on unclear minutes.
  unclearShareWarn: 0.12,
  unclearShareBad: 0.30,
  // A runner-up inside this many standard deviations of the swing between the
  // two plans is not meaningfully behind.
  closeMarginSds: 0.25,
  // Where the discounted certainty of a projected gameweek stops being merely
  // softer and starts being a guess.
  projectedFirm: 0.8,
  projectedSoft: 0.5,
  // How old the underlying data may be before the band says so. Deliberately
  // the SAME six hours the app already uses to withhold a plan on unrefreshed
  // availability (AVAILABILITY_MAX_AGE_SECONDS in ui/plan-model.js), so one
  // idea carries one number. A plan a couple of hours old is an ordinary plan
  // and flagging it would put a caveat on almost every screen, which is how a
  // caveat stops being read.
  dataOldSeconds: 6 * 3600,

  // Band cut points on the summed factor weights.
  moderateFrom: 2,
  lowFrom: 4,
});

export const BAND_LABELS = Object.freeze({
  high: 'High confidence',
  moderate: 'Moderate confidence',
  low: 'Low confidence',
});

// The order clauses are considered in when the sentence has room for only two.
// Availability first because it is a fact rather than a projection.
const FACTOR_ORDER = ['availability', 'minutes', 'reach', 'data', 'margin'];

const HARD_STATUSES = new Set(['i', 's', 'u', 'n']);

function playerOf(gameState, id) {
  if (!gameState || !gameState.players) return null;
  return gameState.players instanceof Map ? gameState.players.get(id) : gameState.players[id];
}

function nameOf(gameState, id) {
  const p = playerOf(gameState, id);
  return p ? p.webName : `player ${id}`;
}

function projectionOf(projections, id, gw) {
  if (!projections) return null;
  if (typeof projections.get === 'function') return projections.get(id, gw);
  const by = projections.byPlayer;
  if (!by) return null;
  const list = by instanceof Map ? by.get(id) : by[id];
  if (!Array.isArray(list)) return null;
  return list[gw - projections.gwFrom] || null;
}

// "Garner, Isak and Saka", capped so a sentence stays a sentence.
function nameList(names, max = 3) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  const joined = shown.length > 1
    ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
    : shown[0] || '';
  return rest > 0 ? `${joined} and others` : joined;
}

/* ------------------------------------------------------------------ factors */

// How much of this gameweek's projected points rests on players whose minutes
// the model is not sure about.
function minutesFactor({ plan, projections }) {
  const xi = plan.startingXI || [];
  let total = 0;
  let unclear = 0;
  for (const id of xi) {
    const row = projectionOf(projections, id, plan.gw);
    if (!row || !Number.isFinite(row.xPoints)) continue;
    total += row.xPoints;
    const shaky = row.confidence === 'low'
      || (Number.isFinite(row.pStart) && row.pStart < CONFIDENCE_PARAMS.unclearStartProbability);
    if (shaky) unclear += row.xPoints;
  }
  if (total <= 0) {
    return { key: 'minutes', weight: 0, share: 0, reason: makeReason('confidence_minutes_unknown', 'no player in this eleven projects points this gameweek', null, 'none') };
  }

  const share = unclear / total;
  const weight = share >= CONFIDENCE_PARAMS.unclearShareBad ? 2
    : share >= CONFIDENCE_PARAMS.unclearShareWarn ? 1 : 0;

  return {
    key: 'minutes',
    weight,
    share,
    reason: weight > 0
      ? makeReason('confidence_minutes', '{v} of this gameweek\'s projected points sits on players whose minutes are unclear', share, 'percent')
      : makeReason('confidence_minutes_ok', 'every player in this eleven has settled minutes', null, 'none'),
  };
}

// Injuries, suspensions and published doubts on the players the plan commits
// to: the eleven it fields plus anyone it is buying.
function availabilityFactor({ plan, gameState }) {
  const ids = new Set([...(plan.startingXI || []), ...(plan.transfersIn || [])]);
  const hard = [];
  const doubtful = [];
  for (const id of ids) {
    const p = playerOf(gameState, id);
    if (!p) continue;
    if (HARD_STATUSES.has(p.status)) hard.push(nameOf(gameState, id));
    else if (p.status === 'd' || (Number.isFinite(p.chanceNext) && p.chanceNext < 1)) doubtful.push(nameOf(gameState, id));
  }

  if (hard.length) {
    const template = hard.length === 1
      ? `{v} player this plan commits to is injured, suspended or out of the squad (${nameList(hard)})`
      : `{v} of the players this plan commits to are injured, suspended or out of the squad (${nameList(hard)})`;
    return {
      key: 'availability',
      weight: 2,
      hard: hard.length,
      doubtful: doubtful.length,
      reason: makeReason('confidence_flagged', template, hard.length, 'count'),
    };
  }
  if (doubtful.length) {
    const template = doubtful.length === 1
      ? `{v} player this plan commits to carries a fitness doubt (${nameList(doubtful)})`
      : `{v} of the players this plan commits to carry a fitness doubt (${nameList(doubtful)})`;
    return {
      key: 'availability',
      weight: doubtful.length >= 2 ? 2 : 1,
      hard: 0,
      doubtful: doubtful.length,
      reason: makeReason('confidence_doubt', template, doubtful.length, 'count'),
    };
  }
  return {
    key: 'availability',
    weight: 0,
    hard: 0,
    doubtful: 0,
    reason: makeReason('confidence_fitness_ok', 'nobody in this eleven is injured, suspended or carrying a doubt', null, 'none'),
  };
}

// How far into the future the claim reaches. Two different ways it can reach:
// the plan is FOR a later gameweek, or the plan is for this one but the move it
// recommends does not pay until later.
function reachFactor({ plan }) {
  const certainty = Number.isFinite(plan.confidence) ? plan.confidence : 1;
  if (plan.certainty === 'projected' || certainty < 0.999) {
    const weight = certainty >= CONFIDENCE_PARAMS.projectedFirm ? 2
      : certainty >= CONFIDENCE_PARAMS.projectedSoft ? 3 : 4;
    return {
      key: 'reach',
      weight,
      certainty,
      reason: makeReason('confidence_projected', 'this is a projection for a later gameweek, which the planner discounts to {v} of this week\'s certainty', certainty, 'percent'),
    };
  }

  const pairs = (plan.explanation && plan.explanation.transferReasons) || [];
  const gwGain = pairs.reduce((s, r) => s + (Number.isFinite(r.gwGain) ? r.gwGain : 0), 0);
  const horizonGain = pairs.reduce((s, r) => s + (Number.isFinite(r.horizonGain) ? r.horizonGain : 0), 0);
  if (pairs.length && gwGain <= 0 && horizonGain > 0) {
    return {
      key: 'reach',
      weight: 1,
      certainty,
      reason: makeReason('confidence_pays_later', 'the move gives up {v} points this gameweek and only pays back over the gameweeks after it', -gwGain),
    };
  }

  return {
    key: 'reach',
    weight: 0,
    certainty,
    reason: makeReason('confidence_this_week', 'this is the plan for this week\'s deadline, not a projection', null, 'none'),
  };
}

// Freshness and completeness of the data underneath. `sources` defaults to the
// planner's own list; the dashboard passes the richer per-request list from the
// API client, which names the failures the user would recognise.
function dataFactor({ dataStatus, sources, now }) {
  const ds = dataStatus || {};
  const list = Array.isArray(sources) ? sources : (ds.sources || []);
  const failed = list.filter(s => s && s.ok === false);
  if (failed.length) {
    const names = nameList(failed.map(s => s.name || 'a source'));
    const template = `{v} of the data sources this plan needs could not be loaded (${names})`;
    return {
      key: 'data',
      weight: 2,
      failed: failed.length,
      reason: makeReason('confidence_source_failed', template, failed.length, 'count'),
    };
  }

  const fetchedAt = ds.fetchedAt ? Date.parse(ds.fetchedAt) : NaN;
  const ageSeconds = Number.isFinite(fetchedAt) ? Math.max(0, (now - fetchedAt) / 1000) : null;
  const ageHours = ageSeconds === null ? null : ageSeconds / 3600;
  const staleSources = list.filter(s => s && s.stale);

  // AGE COUNTS ON ITS OWN, not only when a source is flagged stale.
  //
  // The age was previously computed and then consulted only inside the stale
  // branch, so a plan built on a fetch three days old reported "the player,
  // price and injury data behind this plan is up to date" while the freshness
  // row beside it said "Last synced 3 days ago". Two sentences, one screen,
  // opposite claims.
  const flagged = ds.stale || staleSources.length > 0;
  const old = ageSeconds !== null && ageSeconds >= CONFIDENCE_PARAMS.dataOldSeconds;

  if (flagged || old) {
    return {
      key: 'data',
      weight: 1,
      failed: 0,
      ageHours,
      reason: ageSeconds === null
        ? makeReason('confidence_data_stale', 'the player, price and injury data behind this plan is not fresh', null, 'none')
        : makeReason('confidence_data_age',
          `the player, price and injury data behind this plan is ${describeAge(ageSeconds)} old`, ageHours, 'none'),
    };
  }

  return {
    key: 'data',
    weight: 0,
    failed: 0,
    ageHours,
    reason: makeReason('confidence_data_ok', 'the player, price and injury data behind this plan is up to date', null, 'none'),
  };
}

// Age in the largest unit that still says something useful, matching the
// thresholds ui/format.js uses for "Last synced ...". The two sentences sit
// next to each other on screen, so they have to round the same way: an age of
// ten minutes read as "0 hours old" beside "Last synced 10 minutes ago" was one
// number formatted two ways.
export function describeAge(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return 'a minute';
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  if (s < 7200) return 'an hour';
  if (s < 86400) return `${Math.round(s / 3600)} hours`;
  if (s < 172800) return 'a day';
  return `${Math.round(s / 86400)} days`;
}

// The runner-up, measured against the week-to-week swing on the players the two
// plans actually disagree about. Comparing a horizon delta against the whole
// eleven's standard deviation would compare two different things, so the spread
// is rebuilt from just the players who differ.
function marginFactor({ plan, projections }) {
  const alternatives = (plan.alternatives || []).filter(a => Number.isFinite(a.deltaHorizon));
  if (!alternatives.length) return { key: 'margin', weight: 0, margin: null, reason: null };

  const best = alternatives.reduce((b, a) => (a.deltaHorizon > b.deltaHorizon ? a : b));
  const margin = Math.max(0, -best.deltaHorizon);

  // Reconstruct the alternative's fifteen from the primary's: undo the primary's
  // moves, then apply the alternative's. Whoever is left in one squad and not
  // the other is the disagreement.
  const primary = new Set(plan.squad || []);
  const alt = new Set(primary);
  for (const id of plan.transfersIn || []) alt.delete(id);
  for (const id of plan.transfersOut || []) alt.add(id);
  for (const id of best.transfersOut || []) alt.delete(id);
  for (const id of best.transfersIn || []) alt.add(id);

  const differing = [
    ...[...primary].filter(id => !alt.has(id)),
    ...[...alt].filter(id => !primary.has(id)),
  ];

  let variance = 0;
  for (const id of differing) {
    const row = projectionOf(projections, id, plan.gw);
    if (row && Number.isFinite(row.sd)) variance += row.sd * row.sd;
  }
  const swing = Math.sqrt(variance);
  if (!(swing > 0)) return { key: 'margin', weight: 0, margin, swing: 0, reason: null };

  const close = margin < CONFIDENCE_PARAMS.closeMarginSds * swing;
  // A margin that rounds to 0.0 is a tie, and printing "only 0.0 points behind"
  // reads as a rendering fault rather than as "these two are the same plan".
  const tied = margin < 0.05;
  return {
    key: 'margin',
    weight: close ? 1 : 0,
    margin,
    swing,
    reason: close
      ? (tied
        ? makeReason('confidence_tied', 'a second plan projects the same points over the horizon, so the exact swap matters less than the move itself', margin)
        : makeReason('confidence_close_call', 'the next best plan is only {v} points behind, less than the week-to-week swing on the players the two disagree about', margin))
      : makeReason('confidence_clear_margin', 'this plan beats the next best by {v} points over the horizon', margin),
  };
}

/* ------------------------------------------------------------------- band */

function bandOf(total) {
  if (total >= CONFIDENCE_PARAMS.lowFrom) return 'low';
  if (total >= CONFIDENCE_PARAMS.moderateFrom) return 'moderate';
  return 'high';
}

// Up to two clauses. A shaky band leads with what is wrong; a firm band leads
// with what is right and still names its one caveat, so a HIGH never quietly
// hides the fact that something scored against it. The band never renders
// without this sentence.
function reasonClauses(band, factors) {
  const byOrder = (a, b) => FACTOR_ORDER.indexOf(a.key) - FACTOR_ORDER.indexOf(b.key);
  const named = factors.filter(f => f.reason);
  const negatives = named.filter(f => f.weight > 0).sort((a, b) => (b.weight - a.weight) || byOrder(a, b));
  const positives = named.filter(f => f.weight === 0).sort(byOrder);

  if (band !== 'high' && negatives.length) {
    return negatives.slice(0, 2).map(f => f.reason.text).join(' and ');
  }
  if (negatives.length) {
    if (!positives.length) return negatives[0].reason.text;
    return `${positives[0].reason.text}, though ${negatives[0].reason.text}`;
  }
  return positives.slice(0, 2).map(f => f.reason.text).join(' and ');
}

/**
 * Score one plan. Pure: same inputs, same band, no clock reads beyond the `now`
 * that is passed in.
 *
 * @returns {{band, label, score, reason, factors, drivers}}
 */
export function assessConfidence({ plan, projections, gameState, dataStatus = null, sources = null, now = Date.now() }) {
  const factors = [
    availabilityFactor({ plan, gameState }),
    minutesFactor({ plan, projections }),
    reachFactor({ plan }),
    dataFactor({ dataStatus, sources, now }),
    marginFactor({ plan, projections }),
  ];

  const score = factors.reduce((s, f) => s + f.weight, 0);
  const band = bandOf(score);
  const label = BAND_LABELS[band];
  const because = reasonClauses(band, factors);

  return {
    band,
    label,
    score,
    // The clauses on their own, for a surface that already shows the band as a
    // label and would otherwise print it twice.
    because,
    reason: `${label}, because ${because}.`,
    // Everything that fed the band, for the disclosure that shows the working.
    factors: factors.map(f => ({
      key: f.key,
      weight: f.weight,
      text: f.reason ? f.reason.text : null,
      code: f.reason ? f.reason.code : null,
      value: f.reason ? f.reason.value : null,
      unit: f.reason ? f.reason.unit : null,
    })),
    // Just the ones that cost the plan something, for callers that want the
    // short version without re-filtering.
    drivers: factors.filter(f => f.weight > 0).map(f => f.key),
  };
}
