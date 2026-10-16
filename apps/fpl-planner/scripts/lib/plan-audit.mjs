// What a real manager's squad state and plan must satisfy, judged against
// FPL's own witnesses and against the plan's own numbers.
//
// WHY THIS EXISTS (2026-10-16). Of the 21 user-facing defects found between
// GW1 and GW7 of 2026/27, the owner or a manual pre-gameweek audit found 19,
// the health probe one and CI none. The probe judged FPL's payload and a plan
// for a squad it BUILT, so nothing automated ever read a real manager's
// history, transfers and picks: the free-transfer count that read 2 where FPL
// said 1, the Free Hit team planned as if owned, the false "does not match
// FPL" on every Free Hit revert, and the Alternatives card claiming nothing
// scored higher above a plan that did all reached the owner first. These
// checks run on the scheduled probe against a pinned real entry (and in
// tests/plan-audit.test.mjs), so that class of defect turns the health status
// red rather than waiting to be noticed.
//
// Every function returns a list of failure sentences (empty = holds), never
// throws on a malformed plan, and reads only what it is handed.

import { chargedHitDisagreements } from '../../js/engine/transfer-state.js';
import { planHeadline } from '../../js/engine/explain.js';

const EPS = 1e-6;
// The line the cards draw between a lead and a tie (planner.js alternativeFrom).
const VISIBLE = 0.05;

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));

/**
 * The free-transfer replay against the hits FPL actually charged, every
 * gameweek of the season.
 */
export function freeTransferWitnessFailures({ history, rules }) {
  return chargedHitDisagreements({ history, rules }).map(d =>
    `GW${d.gw}: ${d.transfers} transfer${d.transfers === 1 ? '' : 's'} on ${d.free} free`
    + `${d.chip ? ` under ${d.chip}` : ''} should cost ${d.expected}, FPL charged ${d.charged}`);
}

/**
 * The chips offered for `gw`, recomputed from the raw bootstrap catalogue
 * (`chips[].start_event / stop_event`) and `history.chips`, not from the
 * engine's own rules object. A chip is available in a window that contains
 * `gw` and in which that chip has not been played.
 */
export function chipLedgerFailures({ bootstrap, history, offered, gw }) {
  const played = (history && history.chips) || [];
  const expected = new Set();
  for (const w of bootstrap.chips || []) {
    if (!(w.start_event <= gw && gw <= w.stop_event)) continue;
    const used = played.some(c => c.name === w.name && w.start_event <= c.event && c.event <= w.stop_event);
    if (!used) expected.add(w.name);
  }
  const got = new Set(offered || []);
  const out = [];
  for (const name of got) if (!expected.has(name)) out.push(`${name} is offered but was already played in its half, or is out of window`);
  for (const name of expected) if (!got.has(name)) out.push(`${name} is unplayed and in window but is not offered`);
  return out;
}

/**
 * The squad read from the payloads: fifteen players, the bank FPL reports,
 * and the value check the app shows the manager. A raised `value_mismatch`
 * or `free_hit_squad` on a healthy payload is itself a defect: the first is
 * the reconstruction disagreeing with FPL, the second a Free Hit revert that
 * could not be read.
 */
export function squadReadFailures({ squadState, picks, rules }) {
  const out = [];
  const n = (squadState.picks || []).length;
  if (n !== rules.squadSize) out.push(`${n} players read, expected ${rules.squadSize}`);
  for (const w of squadState.warnings || []) {
    if (w.code === 'value_mismatch' || w.code === 'free_hit_squad' || w.code === 'history_missing') out.push(`${w.code}: ${w.message}`);
  }
  const eh = picks && picks.entry_history;
  const reverted = (squadState.warnings || []).some(w => w.code === 'free_hit_reverted');
  if (eh && !reverted && !(squadState.pendingTransfers || []).length && squadState.bankTenths !== eh.bank) {
    out.push(`bank read as ${squadState.bankTenths} tenths, FPL's picks say ${eh.bank}`);
  }
  for (const p of squadState.picks || []) {
    if (!Number.isFinite(p.sellingTenths) || p.sellingTenths <= 0) out.push(`player ${p.playerId} has no selling price`);
  }
  return out;
}

/**
 * The plan against its own numbers: the decision it shows must be the one
 * its figures support, and every surface that restates a figure reads the
 * same one. These are the contradictions the owner has reported by
 * screenshot.
 */
export function planConsistencyFailures({ bundle, squadState, rules }) {
  const out = [];
  const plan = bundle && bundle.current;
  if (!plan) return ['the bundle carries no current plan'];

  // The one expected-points number is the sum of its named parts (README).
  const m = plan.chip === '3xc' ? 2 : 1;
  const parts = plan.xPointsXi + plan.xPointsAutosubs + m * plan.xPointsCaptaincy + plan.xPointsBenchPaid;
  if (!(Math.abs(parts - plan.xPointsGw) < EPS)) out.push(`xPointsGw ${fmt(plan.xPointsGw)} is not the sum of its parts ${fmt(parts)}`);
  if (!(Math.abs(plan.xPointsNet - (plan.xPointsGw - plan.hitCostPoints)) < EPS)) out.push(`xPointsNet ${fmt(plan.xPointsNet)} is not xPointsGw less the hit`);

  // Money.
  const bank = plan.bankBeforeTenths + plan.moneyInTenths - plan.moneyOutTenths;
  if (bank !== plan.bankAfterTenths) out.push(`bank after ${plan.bankAfterTenths} is not ${plan.bankBeforeTenths} + ${plan.moneyInTenths} - ${plan.moneyOutTenths}`);
  if (plan.bankAfterTenths < 0) out.push(`bank after is negative (${plan.bankAfterTenths})`);
  if (squadState && plan.bankBeforeTenths !== squadState.bankTenths) out.push(`the plan starts from a bank of ${plan.bankBeforeTenths}, the squad has ${squadState.bankTenths}`);

  // The squad the transfers lead to.
  if (squadState) {
    const held = new Set((squadState.picks || []).map(p => p.playerId));
    for (const id of plan.transfersOut) if (!held.has(id)) out.push(`sells ${id}, who is not in the squad`);
    for (const id of plan.transfersIn) if (held.has(id)) out.push(`buys ${id}, who is already in the squad`);
    const after = new Set([...held].filter(id => !plan.transfersOut.includes(id)).concat(plan.transfersIn));
    const same = after.size === plan.squad.length && plan.squad.every(id => after.has(id));
    if (!same) out.push('the plan\'s squad is not the held squad with its transfers applied');
  }
  const fielded = [...plan.startingXI, plan.bench.gk, ...plan.bench.order];
  if (new Set(fielded).size !== rules.squadSize || !fielded.every(id => plan.squad.includes(id))) out.push('the eleven and the bench do not partition the squad');
  if (!plan.startingXI.includes(plan.captain)) out.push('the captain is not in the eleven');
  if (!plan.startingXI.includes(plan.viceCaptain) || plan.viceCaptain === plan.captain) out.push('the vice-captain is not a different member of the eleven');

  // Free transfers: what the plan spends is what it was given.
  const chipFree = plan.chip === 'wildcard' || plan.chip === 'freehit';
  if (squadState && Number.isFinite(squadState.freeTransfers) && !chipFree) {
    if (plan.freeTransfersUsed + plan.hits !== plan.transferCount) out.push(`${plan.transferCount} transfers are not ${plan.freeTransfersUsed} free plus ${plan.hits} hits`);
    if (plan.freeTransfersAfter !== squadState.freeTransfers - plan.freeTransfersUsed) out.push(`free transfers after ${plan.freeTransfersAfter} is not ${squadState.freeTransfers} held less ${plan.freeTransfersUsed} used`);
    if (plan.hits > 0 && plan.freeTransfersUsed !== squadState.freeTransfers) out.push('a hit is taken while a free transfer is left unused');
    const next = Math.min(rules.maxFreeTransfers, plan.freeTransfersAfter + 1);
    if (plan.freeTransfersNextGw !== next) out.push(`next gameweek starts with ${plan.freeTransfersNextGw} free transfers, expected ${next}`);
  }
  // A Wildcard or Free Hit week spends no free transfer, charges no hit, and
  // hands the next gameweek exactly what was banked (the chip uses that
  // week's +1; the 2026-10-09 incident was this +1).
  if (squadState && Number.isFinite(squadState.freeTransfers) && chipFree) {
    if (plan.freeTransfersUsed !== 0 || plan.hits !== 0) out.push(`a ${plan.chip} week spends ${plan.freeTransfersUsed} free transfers and ${plan.hits} hits`);
    if (plan.freeTransfersAfter !== squadState.freeTransfers) out.push(`free transfers after a ${plan.chip} are ${plan.freeTransfersAfter}, ${squadState.freeTransfers} were banked`);
    if (plan.freeTransfersNextGw !== squadState.freeTransfers) out.push(`next gameweek starts with ${plan.freeTransfersNextGw} free transfers after a ${plan.chip}, expected the ${squadState.freeTransfers} banked`);
  }
  if (plan.hitCostPoints !== plan.hits * rules.hitCost) out.push(`${plan.hits} hits are charged ${plan.hitCostPoints} points`);

  // No runner-up outranks the recommendation unless the hit bar overruled
  // it, and none projects visibly more without the card saying why.
  for (const a of plan.alternatives || []) {
    if (a.deltaObjective > EPS && !(a.belowHitMargin && a.deltaObjective < a.hitMarginPoints + EPS)) {
      out.push(`"${a.headline}" ranks ${fmt(a.deltaObjective)} above the plan and was not chosen`);
    }
    if (a.deltaHorizon >= VISIBLE && a.chip === plan.chip && a.deltaWithChipValue === null
      && !a.belowHitMargin && !a.belowRollValue) {
      out.push(`"${a.headline}" projects ${fmt(a.deltaHorizon)} more and its card gives no reason it lost`);
    }
  }

  // The headline says what the plan does: the sentence stored on the plan is
  // the one its own fields produce, so a headline carried over from another
  // plan (the sandbox's, a stale version) cannot sit above this one.
  const head = (plan.explanation && plan.explanation.headline) || '';
  const isDraft = !!squadState && (squadState.source === 'draft' || squadState.source === 'manual');
  const due = planHeadline(plan, { isDraft });
  if (head !== due) out.push(`the headline "${head}" does not describe the plan ("${due}")`);

  // The projected weeks chain: each starts with what the one before leaves.
  let prev = plan;
  for (const f of bundle.future || []) {
    if (f.gw !== prev.gw + 1) out.push(`projected GW${f.gw} does not follow GW${prev.gw}`);
    const startedWith = f.freeTransfersUsed + f.freeTransfersAfter;
    const fChipFree = f.chip === 'wildcard' || f.chip === 'freehit';
    if (!fChipFree && Number.isFinite(prev.freeTransfersNextGw) && startedWith !== prev.freeTransfersNextGw) {
      out.push(`projected GW${f.gw} starts with ${startedWith} free transfers, GW${prev.gw} leaves ${prev.freeTransfersNextGw}`);
    }
    if (f.bankAfterTenths < 0) out.push(`projected GW${f.gw} ends with a negative bank`);
    prev = f;
  }
  return out;
}
