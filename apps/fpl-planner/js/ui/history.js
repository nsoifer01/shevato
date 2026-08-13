// Gameweek history, and the plans this app produced for them.
//
// Two sources, kept visibly separate: what actually happened comes from the FPL
// API (entry/{id}/history plus the picks for each played gameweek), and what
// was recommended comes from the local plan history. A gameweek with no stored
// plan says so rather than implying the app was there.

import { el, card, disclosure, stat } from './dom.js';
import { formatMoney, relativeTime, chipLabel, dateTime, rank, xp } from './format.js';
import { describePlayer } from './plan-model.js';
import { MAX_VERSIONS_PER_GW, MAX_GWS_KEPT } from './store.js';
import { columnChart, trendChart, compactNumber } from './charts.js';

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

// The tiles and charts above the history table. Every number here is a plain
// sum or extreme over rows the table below prints in full, so the charts have a
// text twin on the same screen. `ordered` is oldest first.
export function seasonSummary(ordered, gameState) {
  const played = ordered.filter(r => Number.isFinite(r.points));
  if (!played.length) return null;
  const latest = played[played.length - 1];
  const best = played.reduce((a, b) => (b.points > a.points ? b : a));
  const totalPoints = latest.total_points ?? played.reduce((s, r) => s + r.points, 0);
  const hitsCost = played.reduce((s, r) => s + (r.event_transfers_cost || 0), 0);
  const benchPoints = played.reduce((s, r) => s + (r.points_on_bench || 0), 0);
  const transfers = played.reduce((s, r) => s + (r.event_transfers || 0), 0);
  const averages = new Map((gameState && gameState.events ? gameState.events : [])
    .filter(e => Number.isFinite(e.averageEntryScore))
    .map(e => [e.id, e.averageEntryScore]));
  const beatAverage = played.filter(r => averages.has(r.event) && r.points > averages.get(r.event)).length;
  const withAverage = played.filter(r => averages.has(r.event)).length;
  return {
    played,
    latest,
    best,
    totalPoints,
    hitsCost,
    benchPoints,
    transfers,
    averages,
    beatAverage,
    withAverage,
    meanPoints: played.reduce((s, r) => s + r.points, 0) / played.length,
  };
}

function seasonOverviewCard(ordered, gameState) {
  const s = seasonSummary(ordered, gameState);
  if (!s) return null;

  const tiles = el('div', { class: 'fpl-tiles' }, [
    stat('Total points', String(s.totalPoints), { className: 'fpl-tile', kClass: 'fpl-fact-k', vClass: 'fpl-tile-v' }),
    stat('Overall rank', rank(s.latest.overall_rank), {
      className: 'fpl-tile', kClass: 'fpl-fact-k', vClass: 'fpl-tile-v',
      note: `after Gameweek ${s.latest.event}`,
    }),
    stat('Best gameweek', `${s.best.points} pts`, {
      className: 'fpl-tile', kClass: 'fpl-fact-k', vClass: 'fpl-tile-v',
      note: `Gameweek ${s.best.event}`,
    }),
    stat('Points per gameweek', xp(s.meanPoints), {
      className: 'fpl-tile', kClass: 'fpl-fact-k', vClass: 'fpl-tile-v',
      note: s.withAverage ? `Above the game average in ${s.beatAverage} of ${s.withAverage}` : null,
    }),
    stat('Hits taken', s.hitsCost ? `-${s.hitsCost} pts` : 'None', {
      className: 'fpl-tile', kClass: 'fpl-fact-k', vClass: 'fpl-tile-v',
      note: `${s.transfers} transfers made`,
    }),
    stat('Left on the bench', `${s.benchPoints} pts`, {
      className: 'fpl-tile', kClass: 'fpl-fact-k', vClass: 'fpl-tile-v',
      note: 'across the season',
    }),
  ]);

  const pointsChart = columnChart({
    points: s.played.map(r => ({
      label: String(r.event),
      value: r.points,
      active: r.event === s.best.event,
      note: [
        s.averages.has(r.event) ? `Game average ${s.averages.get(r.event)}` : null,
        r.event_transfers_cost ? `Hit -${r.event_transfers_cost}` : null,
      ].filter(Boolean).join(' · ') || null,
    })),
    formatValue: (v) => `${v} pts`,
    ariaLabel: 'Points per gameweek',
  });

  const rankRows = s.played.filter(r => Number.isFinite(r.overall_rank));
  const rankChart = rankRows.length >= 2 ? trendChart({
    points: rankRows.map(r => ({ label: `GW ${r.event}`, value: r.overall_rank })),
    invert: true,
    formatValue: rank,
    formatTick: compactNumber,
    ariaLabel: 'Overall rank by gameweek. Lower is better, so up on this chart is an improvement.',
  }) : null;

  return card('Season at a glance', [
    tiles,
    el('div', { class: 'fpl-chart-block' }, [
      el('div', { class: 'fpl-chart-title', text: 'Points per gameweek' }),
      pointsChart,
    ]),
    rankRows.length >= 2 ? el('div', { class: 'fpl-chart-block' }, [
      el('div', { class: 'fpl-chart-title', text: 'Overall rank, gameweek by gameweek' }),
      el('div', { class: 'fpl-chart-sub', text: 'Rank improves downwards in the game, so the line rising here means climbing the table.' }),
      rankChart,
    ]) : null,
  ]);
}

export function historyView({ history, planHistory, gameState, captainsByGw = new Map(), now = Date.now() }) {
  const rows = (history && Array.isArray(history.current) ? history.current : []).slice().reverse();
  const chipsByGw = new Map(((history && history.chips) || []).map(c => [c.event, c.name]));

  if (!rows.length) {
    return card('Gameweek history', el('div', { class: 'fpl-empty-state' }, [
      el('span', { class: 'fpl-empty-mark', 'aria-hidden': 'true', html: '<i class="fa-solid fa-hourglass-half"></i>' }),
      el('p', { class: 'fpl-empty', text: 'No gameweek has been scored for this team yet, so there is nothing to look back on.' }),
    ]));
  }

  const overview = seasonOverviewCard(rows.slice().reverse(), gameState);

  const table = el('div', { class: 'fpl-table-wrap' }, el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'GW' }),
      el('th', { class: 'is-num', text: 'Points' }),
      el('th', { class: 'is-num', text: 'GW rank' }),
      el('th', { class: 'is-num', text: 'Overall rank' }),
      el('th', { class: 'is-num', text: 'Transfers' }),
      el('th', { class: 'is-num', text: 'Hit' }),
      el('th', { text: 'Captain' }),
      el('th', { text: 'Chip' }),
      el('th', { class: 'is-num', text: 'Bench' }),
      el('th', { class: 'is-num', text: 'Value' }),
      el('th', { text: 'We recommended' }),
    ])),
    el('tbody', {}, rows.map(r => {
      const captainId = captainsByGw.get(r.event);
      const stored = planHistory && planHistory[String(r.event)];
      const latest = Array.isArray(stored) && stored.length ? stored[stored.length - 1] : null;
      const line = recommendationLine(latest, gameState);
      return el('tr', {}, [
        el('td', {}, el('span', { class: 'fpl-gw-pill', text: `GW ${r.event}` })),
        el('td', { class: 'is-strong is-num', text: String(r.points) }),
        el('td', { class: 'is-num', text: r.rank ? r.rank.toLocaleString('en-GB') : '-' }),
        el('td', { class: 'is-num', text: r.overall_rank ? r.overall_rank.toLocaleString('en-GB') : '-' }),
        el('td', { class: 'is-num', text: String(r.event_transfers) }),
        el('td', { class: `is-num ${r.event_transfers_cost ? 'is-bad' : ''}`.trim(), text: r.event_transfers_cost ? `-${r.event_transfers_cost}` : '0' }),
        el('td', { text: captainId ? describePlayer(gameState, captainId).name : '-' }),
        chipsByGw.has(r.event)
          ? el('td', {}, el('span', { class: 'fpl-chip is-chip-played', text: chipLabel(chipsByGw.get(r.event)) }))
          : el('td', { text: '-' }),
        el('td', { class: 'is-num', text: String(r.points_on_bench) }),
        el('td', { class: 'is-num', text: formatMoney(r.value) }),
        el('td', { class: 'is-rec', text: line || 'No plan saved' }),
      ]);
    })),
  ]));

  return [
    overview,
    card('Gameweek history', [
      el('p', { class: 'fpl-note', style: 'margin-bottom:14px' }, 'Points, ranks, transfers, hits, captain and chip come from Fantasy Premier League. The last column is what this app recommended for that gameweek, where a plan was saved on this device.'),
      table,
    ]),
  ];
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
          el('th', { class: 'is-num', text: 'xP this GW' }),
        ])),
        el('tbody', {}, versions.map(v => el('tr', {}, [
          el('td', { class: 'is-strong', text: `v${v.version}` }),
          el('td', { text: `${relativeTime(v.computedAt, now)} (${dateTime(v.computedAt)})` }),
          el('td', { text: reasonLabel(v.reason) }),
          el('td', { class: 'is-rec', text: recommendationLine(v, gameState) || '-' }),
          el('td', { class: 'is-num', text: v.plan && Number.isFinite(v.plan.xPointsGw) ? v.plan.xPointsGw.toFixed(1) : '-' }),
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
