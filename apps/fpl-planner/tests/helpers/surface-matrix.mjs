// Real GW7 plans rendered to plain data, for tests/surface-consistency.test.mjs.
//
// WHY A WORKER. The matrix is about 60 real plans, and a plan that holds a
// Wildcard costs 4 to 6 seconds of search (measured 2026-10-16: about 115 s of
// CPU for the whole matrix), so one thread cannot run it inside the file's
// 40 s budget. A plan bundle cannot cross a thread boundary either (its
// projections index carries methods), so each worker builds the plan, renders
// every view with the shipped dashboard code under mini-dom, and posts back
// only what the invariants read: the rendered lines plus the plan fields they
// compare against.
//
// Run as a worker it answers one { case } message at a time; imported, it
// exports renderCase() so the same code can be run in-process.

import { parentPort, isMainThread } from 'node:worker_threads';

import { installDom, queryAll, query, textOf } from './mini-dom.mjs';
import { ENTRIES, GAME_STATE, PLAN_GW, APP_OPTIONS, FETCHED_AT } from './gw7-fixture.mjs';

installDom();

const { buildPlan } = await import('../../js/engine/planner.js');
const { buildSquadState } = await import('../../js/engine/squad.js');
const { shownDelta } = await import('../../js/engine/confidence.js');
const { betterLaterGw, chipWindowAt, chipLabel } = await import('../../js/engine/chips.js');
const D = await import('../../js/ui/dashboard.js');

export const NOW = Date.parse(FETCHED_AT);
export const ALL_CHIPS = ['wildcard', 'freehit', 'bboost', '3xc'];

// A manager, optionally with exactly `keep` first-half chips unspent (the
// others spent in GW2 onwards, as the 2026-10-16 audit swept), planned at `gw`.
export function squadOf({ label, keep, gw }) {
  const e = JSON.parse(JSON.stringify(ENTRIES[label]));
  if (keep) e.history.chips = ALL_CHIPS.filter(c => !keep.includes(c)).map((name, i) => ({ name, event: i + 2 }));
  const squad = buildSquadState({ ...e, gameState: GAME_STATE, gw: PLAN_GW });
  return gw === PLAN_GW ? squad : { ...squad, gw };
}

// Text as a reader sees it: inline elements run on within their line, block
// elements start a new one. textOf() glues blocks together ("Free HitNot
// played"), which would hide a doubled space or invent a missing one.
const INLINE = new Set(['B', 'STRONG', 'EM', 'I', 'A', 'CODE', 'SMALL', 'ABBR']);
function flat(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.data;
  const inner = node.childNodes.map(flat).join('');
  return INLINE.has(node.tagName) ? inner : `\n${inner}\n`;
}
export const linesOf = (node) => flat(node).split('\n').map(s => s.trim()).filter(Boolean);

const num = (s) => Number(String(s).replace('−', '-'));
const bold = (node) => textOf(node.childNodes.find(n => n.tagName === 'B'));

export async function renderCase(c) {
  const squadState = squadOf(c);
  const bundle = await buildPlan({
    gameState: GAME_STATE,
    squadState,
    options: { ...APP_OPTIONS, risk: c.risk, horizon: c.horizon },
  });
  const plan = bundle.current;
  const gameState = GAME_STATE;
  const views = {
    hero: D.heroCard({ bundle, gameState, event: { deadline: '2026-10-17T10:00:00Z' }, now: NOW }),
    transfers: D.transfersCard({ bundle, gameState, now: NOW }),
    chips: D.chipCard({ bundle, gameState }),
    pitch: D.pitchCard({ bundle, gameState }),
    why: D.whyCard({ bundle, gameState, open: true, now: NOW }),
    alternatives: D.alternativesCard({ bundle, open: true }),
    future: D.futureCard({ bundle, gameState, now: NOW }),
    status: D.statusCard({ bundle, sources: [], runnerMode: 'worker', modelStatus: null, open: true, now: NOW }),
  };

  // The alternatives card, row by row: title, the figure in bold, the sentence.
  const altRows = queryAll(views.alternatives, 'fpl-alt').map(row => {
    const delta = query(row, 'fpl-alt-delta');
    return {
      title: textOf(query(row, 'fpl-alt-title')),
      figure: num(bold(delta).replace(/ pts$/, '')),
      sentence: linesOf(delta).join(' '),
    };
  });

  // The chips card's per-chip rows, its headline and body, and the hero's
  // chip fact.
  const chipNames = ALL_CHIPS.map(chipLabel);
  const chipRows = {};
  for (const k of queryAll(views.chips, 'fpl-kv-k')) {
    const label = textOf(k);
    if (chipNames.includes(label)) chipRows[label] = textOf(k.parentNode.childNodes.find(n => n.className === 'fpl-kv-v'));
  }
  const fact = queryAll(views.hero, 'fpl-fact').find(f => textOf(query(f, 'fpl-fact-k')) === 'Chip');

  // The transfer card's money row, as printed.
  const moneyRow = query(views.transfers, 'fpl-money-row');
  const money = {};
  for (const span of moneyRow.childNodes.filter(n => n.nodeType === 1)) {
    money[linesOf(span)[0].replace(/\s*\S+$/, '')] = bold(span);
  }

  const gw = plan.gw;
  const perChip = (plan.explanation.chipReason && plan.explanation.chipReason.perChip) || {};
  return {
    case: c,
    lines: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, linesOf(v)])),
    altRows,
    chips: {
      rows: chipRows,
      title: textOf(query(views.chips, 'fpl-affirm-title')),
      body: linesOf(query(views.chips, 'fpl-affirm-body')).join(' '),
      heroValue: fact ? textOf(query(fact, 'fpl-fact-v')) : null,
      heroNote: fact ? textOf(query(fact, 'fpl-fact-note')) : null,
    },
    money,
    risk: bundle.dataStatus && bundle.dataStatus.risk,
    plan: {
      gw,
      chip: plan.chip,
      transferCount: plan.transferCount,
      transfersIn: plan.transfersIn || [],
      transfersOut: plan.transfersOut || [],
      bankBeforeTenths: plan.bankBeforeTenths,
      moneyInTenths: plan.moneyInTenths,
      moneyOutTenths: plan.moneyOutTenths,
      bankAfterTenths: plan.bankAfterTenths,
      alternatives: plan.alternatives.map(a => ({
        headline: a.headline,
        chip: a.chip,
        transfersIn: a.transfersIn || [],
        transfersOut: a.transfersOut || [],
        deltaHorizon: a.deltaHorizon,
        deltaWithChipValue: Number.isFinite(a.deltaWithChipValue) ? a.deltaWithChipValue : null,
        shown: shownDelta(a),
        belowHitMargin: !!a.belowHitMargin,
        belowRollValue: !!a.belowRollValue,
        belowRiskPreference: !!a.belowRiskPreference,
      })),
    },
    // Per chip: the engine's entry, the week betterLaterGw names, and the
    // window read straight from the rules (not through expiringChips, so a
    // regression in that helper cannot vouch for itself).
    perChip: Object.values(perChip).map(e => ({
      chip: e.chip,
      label: chipLabel(e.chip),
      available: e.available,
      recommended: !!e.recommended,
      valueNow: Number.isFinite(e.valueNow) ? e.valueNow : null,
      bestValue: Number.isFinite(e.bestValue) ? e.bestValue : null,
      later: betterLaterGw(e, gw),
    })),
    windows: Object.fromEntries(ALL_CHIPS.map(name => [name, chipWindowAt(gameState.rules, name, gw, squadState.chipsUsed || [])])),
    chipsAvailable: squadState.chipsAvailable || [],
  };
}

if (!isMainThread && parentPort) {
  parentPort.on('message', async ({ id, c }) => {
    try {
      parentPort.postMessage({ id, result: await renderCase(c) });
    } catch (err) {
      parentPort.postMessage({ id, error: String(err && err.stack || err) });
    }
  });
}
