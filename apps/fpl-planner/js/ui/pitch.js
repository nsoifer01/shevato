// The pitch: an eleven laid out by its actual formation, with the bench below
// it in auto-sub order.
//
// The rows come from the formation string the optimizer produced, not from a
// lookup table of known shapes, so a formation the game allows but nobody has
// listed still renders correctly. Players are bucketed by their real position
// (ui/plan-model.js pitchRows), so the order inside startingXI never matters.

import { el } from './dom.js';
import { formatMoney, xp } from './format.js';
import { pitchRows, describePlayer, fixtureLabel, availability, getProjection } from './plan-model.js';
import { formationOf, goalkeeperPositionId } from '../engine/validate.js';

const POSITION_COLORS = [
  ['GKP', 'var(--amber)'],
  ['DEF', 'var(--accent)'],
  ['MID', 'var(--green)'],
  ['FWD', 'var(--violet)'],
];

function rawPlayer(gameState, id) {
  return gameState.players instanceof Map ? gameState.players.get(id) : null;
}

export function playerCard({
  playerId, gameState, projections, gw, isCaptain = false, isVice = false, move = null, benchNumber = null, isBenchGk = false, onClick = null,
}) {
  const info = describePlayer(gameState, playerId);
  const row = getProjection(projections, playerId, gw);
  const avail = availability(rawPlayer(gameState, playerId));
  const fixtures = row && Array.isArray(row.fixtures) ? row.fixtures : [];

  const classes = ['fpl-pp', `pos-${info.position}`];
  if (avail && avail.kind === 'out') classes.push('is-injured');
  if (avail && avail.kind === 'doubt') classes.push('is-doubtful');
  if (row && fixtures.length === 0) classes.push('is-blank');
  if (move === 'in') classes.push('is-moving-in');
  if (move === 'out') classes.push('is-moving-out');

  const flags = [];
  if (fixtures.length >= 2) flags.push(el('span', { class: 'fpl-chip is-dgw', text: `DGW ${fixtures.length}` }));
  if (row && fixtures.length === 0) flags.push(el('span', { class: 'fpl-chip is-bgw', text: 'Blank' }));
  if (avail && avail.kind === 'out') flags.push(el('span', { class: 'fpl-chip is-inj', text: avail.label, title: avail.news }));
  if (avail && avail.kind === 'doubt') flags.push(el('span', { class: 'fpl-chip is-doubt', text: avail.label, title: avail.news }));

  if (onClick) classes.push('is-press');
  const card = el('div', {
    class: classes.join(' '),
    title: avail && avail.news ? avail.news : null,
    tabindex: onClick ? '0' : null,
    role: onClick ? 'button' : null,
    'aria-label': onClick ? `${info.name}: open player details` : null,
  }, [
    isCaptain ? el('span', { class: 'fpl-pp-arm is-c', text: 'C', title: 'Captain' }) : null,
    !isCaptain && isVice ? el('span', { class: 'fpl-pp-arm is-v', text: 'V', title: 'Vice-captain' }) : null,
    move ? el('span', { class: `fpl-pp-move is-${move}`, text: move === 'in' ? 'IN' : 'OUT' }) : null,
    el('div', { class: 'fpl-pp-name', text: info.name }),
    el('div', { class: 'fpl-pp-meta', text: `${info.club} · ${info.positionShort} · ${formatMoney(info.priceTenths)}` }),
    el('div', { class: 'fpl-pp-fix', text: fixtureLabel(row, gameState) }),
    el('div', { class: 'fpl-pp-xp' }, [row ? xp(row.xPoints) : '-', el('span', { text: 'xP' })]),
    flags.length ? el('div', { class: 'fpl-pp-flags' }, flags) : null,
  ]);

  if (onClick) {
    card.addEventListener('click', () => onClick(playerId, { trigger: card }));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onClick(playerId, { trigger: card });
      }
    });
  }

  if (benchNumber !== null) {
    return el('div', { class: `fpl-bench-slot ${isBenchGk ? 'is-gk' : ''}`.trim() }, [
      el('span', { class: 'fpl-bench-num', text: isBenchGk ? 'GK' : String(benchNumber) }),
      card,
    ]);
  }
  return card;
}

// A squad as the pitch needs it, from either side of the toggle.
//   recommended: what the plan says to field this gameweek
//   current:     the eleven and bench the manager has right now
export function pitchViewModel({ mode, plan, squadState, gameState }) {
  if (mode === 'current') {
    const picks = (squadState.picks || []).slice().sort((a, b) => a.slot - b.slot);
    const xi = picks.filter(p => p.slot <= 11).map(p => p.playerId);
    const benchPicks = picks.filter(p => p.slot > 11);
    const gkId = goalkeeperPositionId(gameState.rules);
    const benchGk = benchPicks.find(p => {
      const player = rawPlayer(gameState, p.playerId);
      return player && player.position === gkId;
    });
    const captain = picks.find(p => p.isCaptain);
    const vice = picks.find(p => p.isViceCaptain);
    const positionOf = id => {
      const player = rawPlayer(gameState, id);
      return player ? player.position : 0;
    };
    return {
      startingXI: xi,
      formation: formationOf(xi, positionOf, gameState.rules),
      bench: {
        gk: benchGk ? benchGk.playerId : null,
        order: benchPicks.filter(p => !benchGk || p.playerId !== benchGk.playerId).map(p => p.playerId),
      },
      captain: captain ? captain.playerId : null,
      viceCaptain: vice ? vice.playerId : null,
      // The current squad is where a departing player still is, so this is the
      // side of the toggle that can mark OUT.
      movesOut: new Set(plan.transfersOut || []),
      movesIn: new Set(),
    };
  }

  return {
    startingXI: plan.startingXI,
    formation: plan.formation,
    bench: plan.bench,
    captain: plan.captain,
    viceCaptain: plan.viceCaptain,
    movesOut: new Set(),
    movesIn: new Set(plan.transfersIn || []),
  };
}

export function renderPitch({ mode, plan, squadState, gameState, projections, gw, onPlayerClick = null }) {
  const vm = pitchViewModel({ mode, plan, squadState, gameState });
  const positionOf = id => {
    const player = rawPlayer(gameState, id);
    return player ? player.position : 0;
  };
  const rows = pitchRows(vm.startingXI, vm.formation, positionOf) || [vm.startingXI];

  const moveOf = (id) => (vm.movesIn.has(id) ? 'in' : vm.movesOut.has(id) ? 'out' : null);

  const pitch = el('div', { class: 'fpl-pitch' }, rows.map(ids => el('div', { class: 'fpl-row' }, ids.map(id => playerCard({
    playerId: id, gameState, projections, gw,
    isCaptain: id === vm.captain,
    isVice: id === vm.viceCaptain,
    move: moveOf(id),
    onClick: onPlayerClick,
  })))));

  const benchOrder = vm.bench && Array.isArray(vm.bench.order) ? vm.bench.order : [];
  const bench = el('div', { class: 'fpl-bench' }, [
    el('div', { class: 'fpl-bench-title', text: 'Bench, in auto-sub order' }),
    el('div', { class: 'fpl-bench-row' }, [
      vm.bench && vm.bench.gk
        ? playerCard({ playerId: vm.bench.gk, gameState, projections, gw, move: moveOf(vm.bench.gk), benchNumber: 0, isBenchGk: true, onClick: onPlayerClick })
        : null,
      ...benchOrder.map((id, i) => playerCard({
        playerId: id, gameState, projections, gw, move: moveOf(id), benchNumber: i + 1, onClick: onPlayerClick,
      })),
    ]),
  ]);

  const legend = el('div', { class: 'fpl-pitch-legend' }, [
    ...POSITION_COLORS.map(([label, color]) => el('span', {}, [
      el('i', { class: 'fpl-legend-dot', style: `background:${color}` }),
      label,
    ])),
    el('span', { text: 'DGW / Blank from the fixture list' }),
    el('span', { text: mode === 'current' ? 'OUT marks a player the plan sells' : 'IN marks a player the plan buys' }),
  ]);

  return el('div', {}, [
    el('div', { class: 'fpl-note', style: 'margin-bottom:12px' }, [
      mode === 'current' ? 'Your squad as it stands, ' : 'The eleven this plan fields, ',
      el('b', { text: vm.formation }),
      `. Expected points shown are for Gameweek ${gw}.`,
    ]),
    pitch,
    bench,
    legend,
  ]);
}
