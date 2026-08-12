// Gameweek history, and the plans this app produced for them.
//
// Two sources, kept visibly separate: what actually happened comes from the FPL
// API (entry/{id}/history plus the picks for each played gameweek), and what
// was recommended comes from the local plan history. A gameweek with no stored
// plan says so rather than implying the app was there.

import { el, card, disclosure } from './dom.js';
import { formatMoney, relativeTime, chipLabel, dateTime } from './format.js';
import { describePlayer } from './plan-model.js';
import { MAX_VERSIONS_PER_GW, MAX_GWS_KEPT } from './store.js';

// What the app recommended for a gameweek, in one line, from the stored
// compact plan. Never a rationale: just the action.
export function recommendationLine(entry, gameState) {
  if (!entry || !entry.plan) return null;
  const plan = entry.plan;
  if (plan.headline) {
    if (plan.transferCount && gameState) {
      // Paired, the way the hero says it. Listing every OUT and then every IN
      // ("Garner, F.Kadıoğlu out, Brooks, Botman in") makes the reader work out
      // which sale funded which buy, which is exactly what the plan decided.
      const name = id => describePlayer(gameState, id).name;
      const ins = plan.transfersIn || [];
      const pairs = (plan.transfersOut || []).map((out, i) => (
        ins[i] === undefined ? `${name(out)} out` : `${name(out)} out, ${name(ins[i])} in`
      ));
      return `${plan.headline}: ${pairs.join('; ')}`;
    }
    return plan.headline;
  }
  return plan.transferCount ? `${plan.transferCount} transfers` : 'No transfers';
}

export function historyView({ history, planHistory, gameState, captainsByGw = new Map(), now = Date.now() }) {
  const rows = (history && Array.isArray(history.current) ? history.current : []).slice().reverse();
  const chipsByGw = new Map(((history && history.chips) || []).map(c => [c.event, c.name]));

  if (!rows.length) {
    return card('Gameweek history', el('p', { class: 'fpl-empty', text: 'No gameweek has been scored for this team yet, so there is nothing to look back on.' }));
  }

  const table = el('div', { class: 'fpl-table-wrap' }, el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'GW' }),
      el('th', { text: 'Points' }),
      el('th', { text: 'GW rank' }),
      el('th', { text: 'Overall rank' }),
      el('th', { text: 'Transfers' }),
      el('th', { text: 'Hit' }),
      el('th', { text: 'Captain' }),
      el('th', { text: 'Chip' }),
      el('th', { text: 'Bench' }),
      el('th', { text: 'Value' }),
      el('th', { text: 'We recommended' }),
    ])),
    el('tbody', {}, rows.map(r => {
      const captainId = captainsByGw.get(r.event);
      const stored = planHistory && planHistory[String(r.event)];
      const latest = Array.isArray(stored) && stored.length ? stored[stored.length - 1] : null;
      const line = recommendationLine(latest, gameState);
      return el('tr', {}, [
        el('td', { class: 'is-strong', text: `GW ${r.event}` }),
        el('td', { class: 'is-strong', text: String(r.points) }),
        el('td', { text: r.rank ? r.rank.toLocaleString('en-GB') : '-' }),
        el('td', { text: r.overall_rank ? r.overall_rank.toLocaleString('en-GB') : '-' }),
        el('td', { text: String(r.event_transfers) }),
        el('td', { text: r.event_transfers_cost ? `-${r.event_transfers_cost}` : '0' }),
        el('td', { text: captainId ? describePlayer(gameState, captainId).name : '-' }),
        el('td', { text: chipsByGw.has(r.event) ? chipLabel(chipsByGw.get(r.event)) : '-' }),
        el('td', { text: String(r.points_on_bench) }),
        el('td', { text: formatMoney(r.value) }),
        el('td', { text: line || 'No plan saved' }),
      ]);
    })),
  ]));

  return card('Gameweek history', [
    el('p', { class: 'fpl-note', style: 'margin-bottom:14px' }, 'Points, ranks, transfers, hits, captain and chip come from Fantasy Premier League. The last column is what this app recommended for that gameweek, where a plan was saved on this device.'),
    table,
  ]);
}

// Every plan this app has calculated, newest gameweek first, with the versions
// inside each gameweek. Versions exist because a plan is only true of the
// inputs it was built from, and those move during a week.
export function planVersionsView({ planHistory, gameState, now = Date.now() }) {
  const gws = Object.keys(planHistory || {}).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  if (!gws.length) {
    return disclosure('Saved plans', el('p', { class: 'fpl-empty', text: 'Plans are saved as they are calculated. Nothing has been saved on this device yet.' }));
  }

  const blocks = gws.map(gw => {
    const versions = planHistory[String(gw)].slice().reverse();
    return el('div', {}, [
      el('div', { class: 'fpl-subhead', text: `Gameweek ${gw}` }),
      el('div', { class: 'fpl-table-wrap' }, el('table', {}, [
        el('thead', {}, el('tr', {}, [
          el('th', { text: 'Version' }),
          el('th', { text: 'Calculated' }),
          el('th', { text: 'Why it was recalculated' }),
          el('th', { text: 'Recommendation' }),
          el('th', { text: 'xP this GW' }),
        ])),
        el('tbody', {}, versions.map(v => el('tr', {}, [
          el('td', { class: 'is-strong', text: `v${v.version}` }),
          el('td', { text: `${relativeTime(v.computedAt, now)} (${dateTime(v.computedAt)})` }),
          el('td', { text: reasonLabel(v.reason) }),
          el('td', { text: recommendationLine(v, gameState) || '-' }),
          el('td', { text: v.plan && Number.isFinite(v.plan.xPointsGw) ? v.plan.xPointsGw.toFixed(1) : '-' }),
        ]))),
      ])),
    ]);
  });

  return disclosure('Saved plans', [
    el('p', { class: 'fpl-note', style: 'margin-bottom:12px' }, `Up to ${MAX_VERSIONS_PER_GW} versions per gameweek and ${MAX_GWS_KEPT} gameweeks are kept, so this list stays small enough to sync with your account.`),
    ...blocks,
  ]);
}

const REASONS = {
  'first-calculation': 'First plan for this gameweek',
  'new-gameweek': 'A new gameweek started',
  'squad-changed': 'Your squad changed',
  'budget-changed': 'Your bank or free transfers changed',
  'players-changed': 'Prices or availability changed',
  'settings-changed': 'You changed the planner settings',
  manual: 'You asked for a recalculation',
};

export function reasonLabel(reason) {
  return REASONS[reason] || reason || 'Recalculated';
}
