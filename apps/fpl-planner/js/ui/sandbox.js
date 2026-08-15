// The team sandbox: the editable view of a squad.
//
// This file draws and dispatches. It holds no FPL rules: every legality
// question goes to js/ui/scenario.js, which asks validate.js, and every money
// question is answered by the same reconstruction the planner uses. If a
// control here is refused, the sentence shown is the validator's own.
//
// THE INTERACTION MODEL, AND WHY IT IS NOT DRAG AND DROP
//
// Dragging a card onto another is the obvious gesture and the wrong one here.
// It is hostile on a phone (the pitch scrolls under the finger), it is
// unreachable by keyboard without building a parallel command layer anyway, and
// it hides the reason a move is illegal at exactly the moment the user needs
// it. So the model is SELECT then ACT:
//
//   1. Activate a player. He becomes selected and an action bar appears with
//      everything that can be done to him, each button labelled.
//   2. "Swap" turns every other player into a target. Legal targets are marked;
//      choosing an illegal one explains why instead of ignoring the press.
//
// Every step is a button, so the keyboard gets it free, screen readers announce
// it, and the same code runs on a phone and a desktop.

import { el, append, disclosure } from './dom.js';
import { formatMoney, xp } from './format.js';
import { btn, banner } from './parts.js';
import { describePlayer, fixtureLabel, availability, getProjection, pitchRows } from './plan-model.js';
import { formationOf, goalkeeperPositionId } from '../engine/validate.js';
import {
  scenarioSummary, transferCandidates, swapPlayers, sellTenthsFor, seedDiff, isFreshBuild,
} from './scenario.js';
import { combobox } from './combobox.js';

const rawPlayer = (gameState, id) => (gameState.players instanceof Map ? gameState.players.get(id) : null);
const signed = (n, digits = 1) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toFixed(digits)}`;

/* ------------------------------------------------------------ player card */

// The sandbox draws its own card rather than reusing pitch.js's, because an
// editable card is a different control: it carries selection and target state,
// an optional projection detail block, and it must never be mistaken for the
// read-only pitch sitting one tab away.
function editableCard({
  playerId, gameState, projections, gw, horizon, scenario, showXp,
  selection, targetInfo, onSelect, benchNumber = null, isBenchGk = false,
}) {
  const info = describePlayer(gameState, playerId);
  const row = getProjection(projections, playerId, gw);
  const avail = availability(rawPlayer(gameState, playerId));
  const fixtures = row && Array.isArray(row.fixtures) ? row.fixtures : [];

  const isSelected = selection && selection.playerId === playerId;
  const isTarget = !!targetInfo;
  const isBlockedTarget = isTarget && !!targetInfo.blocked;

  const classes = ['fpl-pp', 'fpl-pp-edit', `pos-${info.position}`];
  if (avail && avail.kind === 'out') classes.push('is-injured');
  if (avail && avail.kind === 'doubt') classes.push('is-doubtful');
  if (row && fixtures.length === 0) classes.push('is-blank');
  if (isSelected) classes.push('is-selected');
  if (isTarget && !isBlockedTarget) classes.push('is-target');
  if (isBlockedTarget) classes.push('is-target-blocked');

  const isCaptain = scenario.captain === playerId;
  const isVice = scenario.viceCaptain === playerId;

  const flags = [];
  if (fixtures.length >= 2) flags.push(el('span', { class: 'fpl-chip is-dgw', text: `DGW ${fixtures.length}` }));
  if (row && fixtures.length === 0) flags.push(el('span', { class: 'fpl-chip is-bgw', text: 'Blank' }));
  if (avail && avail.kind === 'out') flags.push(el('span', { class: 'fpl-chip is-inj', text: avail.label, title: avail.news }));
  if (avail && avail.kind === 'doubt') flags.push(el('span', { class: 'fpl-chip is-doubt', text: avail.label, title: avail.news }));

  // Progressive disclosure: the card always carries name, club, price, fixture
  // and this gameweek's projection, because those are what a decision needs.
  // Start probability, expected minutes and the multi-gameweek shape appear
  // only when asked for, so the pitch does not become a spreadsheet.
  let detail = null;
  if (showXp && row) {
    const pStart = Number.isFinite(row.pStart) ? `${Math.round(row.pStart * 100)}% start` : null;
    const mins = Number.isFinite(row.xMins) ? `${Math.round(row.xMins)}'` : null;
    const nextRows = [];
    for (let g = gw; g < gw + Math.min(horizon || 1, 5); g++) {
      const r = getProjection(projections, playerId, g);
      nextRows.push(el('span', { class: 'fpl-pp-gw', title: `Gameweek ${g}` }, [
        el('i', { text: `GW${g}` }),
        r ? xp(r.xPoints) : '-',
      ]));
    }
    detail = el('div', { class: 'fpl-pp-detail' }, [
      el('div', { class: 'fpl-pp-mins', text: [pStart, mins].filter(Boolean).join(' · ') || 'No minutes projected' }),
      nextRows.length > 1 ? el('div', { class: 'fpl-pp-gws' }, nextRows) : null,
    ]);
  }

  const label = isTarget
    ? `${info.name}: ${targetInfo.blocked ? 'cannot swap, ' + targetInfo.blocked : 'swap with the selected player'}`
    : `${info.name}, ${info.positionShort}, ${formatMoney(info.priceTenths)}: choose an action`;

  const node = el('div', {
    class: classes.join(' '),
    tabindex: '0',
    role: 'button',
    'aria-pressed': isSelected ? 'true' : 'false',
    'aria-label': label,
    title: avail && avail.news ? avail.news : null,
  }, [
    isCaptain ? el('span', { class: 'fpl-pp-arm is-c', text: 'C', title: 'Captain' }) : null,
    !isCaptain && isVice ? el('span', { class: 'fpl-pp-arm is-v', text: 'V', title: 'Vice-captain' }) : null,
    el('div', { class: 'fpl-pp-name', text: info.name }),
    el('div', { class: 'fpl-pp-meta', text: `${info.club} · ${info.positionShort} · ${formatMoney(info.priceTenths)}` }),
    el('div', { class: 'fpl-pp-fix', text: fixtureLabel(row, gameState) }),
    el('div', { class: 'fpl-pp-xp' }, [row ? xp(row.xPoints) : '-', el('span', { text: 'xP' })]),
    detail,
    flags.length ? el('div', { class: 'fpl-pp-flags' }, flags) : null,
    isBlockedTarget ? el('div', { class: 'fpl-pp-blocked', text: targetInfo.blocked }) : null,
  ]);

  const activate = () => onSelect(playerId);
  node.addEventListener('click', activate);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });

  if (benchNumber !== null) {
    return el('div', { class: `fpl-bench-slot ${isBenchGk ? 'is-gk' : ''}`.trim() }, [
      el('span', { class: 'fpl-bench-num', text: isBenchGk ? 'GK' : String(benchNumber) }),
      node,
    ]);
  }
  return node;
}

/* -------------------------------------------------------------- summaries */

// Before and after, in the four numbers a manager actually weighs. Every one of
// them comes from scenario.js; nothing is computed here.
function comparisonStrip(summary, { horizon }) {
  const c = summary.compare;
  const cell = (label, before, after, delta, note) => el('div', { class: 'fpl-cmp' }, [
    el('div', { class: 'fpl-cmp-k', text: label }),
    el('div', { class: 'fpl-cmp-v' }, [
      el('span', { class: 'fpl-cmp-before', text: before }),
      el('span', { class: 'fpl-cmp-arrow', 'aria-label': 'becomes', text: '→' }),
      el('span', { class: 'fpl-cmp-after', text: after }),
    ]),
    delta !== null
      ? el('div', { class: `fpl-cmp-d ${delta > 0.05 ? 'is-up' : delta < -0.05 ? 'is-down' : ''}`.trim(), text: note })
      : el('div', { class: 'fpl-cmp-d', text: note || '' }),
  ]);

  return el('div', { class: 'fpl-cmp-row' }, [
    cell('This gameweek', xp(c.gw.before), xp(c.gw.after), c.gw.delta, `${signed(c.gw.delta)} xP`),
    // Named for what it measures. This one scores the SQUAD across the horizon,
    // fielding the best eleven each week, so it answers "are these fifteen
    // better" and deliberately not "is this eleven better".
    cell(`Squad, next ${horizon} GWs`, xp(c.horizon.before), xp(c.horizon.after), c.horizon.delta, `${signed(c.horizon.delta)} xP`),
    cell('In the bank', formatMoney(c.bank.before), formatMoney(c.bank.after), null,
      c.transfers ? `${c.transfers} transfer${c.transfers === 1 ? '' : 's'}` : 'no transfers'),
    cell('Points hit', '0', c.hitCostPoints ? `-${c.hitCostPoints}` : '0', -c.hitCostPoints,
      c.hits ? `${c.hits} hit${c.hits === 1 ? '' : 's'}` : 'no hit'),
  ]);
}

// The one line that answers "is this worth doing". It is the horizon gain the
// planner would weigh minus what the hits cost, which is the same quantity the
// optimizer maximizes, so a positive number here means the planner would also
// call this an improvement on the squad it started from.
function verdictLine(summary, horizon) {
  const c = summary.compare;
  if (!summary.dirty) {
    return el('p', { class: 'fpl-note', text: 'This is your team exactly as it stands. Change something and the effect appears here.' });
  }
  // WHICH NUMBER LEADS DEPENDS ON WHAT CHANGED, and getting this wrong made the
  // feature lie during its first run.
  //
  // The horizon figure is a property of the SQUAD: every future gameweek in it
  // is scored with its own best eleven, because today's lineup does not bind
  // next week's. So a change that keeps the squad and only moves the armband or
  // the eleven leaves the horizon EXACTLY unchanged, and leading with it
  // reported "level" to a manager who had just cost himself two points this
  // Saturday. When no transfer was made, this gameweek is the whole story.
  const movedSquad = c.transfers > 0;
  const value = movedSquad ? c.netHorizon : c.gw.delta;
  const tone = value > 0.05 ? 'is-up' : value < -0.05 ? 'is-down' : '';

  let verdict;
  if (movedSquad) {
    const tail = c.hitCostPoints ? `, after the ${c.hitCostPoints} point hit` : '';
    verdict = Math.abs(value) <= 0.05
      ? `Your transfers come out level over the next ${horizon} gameweeks${tail}.`
      : `Your transfers project ${signed(value)} points over the next ${horizon} gameweeks${tail}.`;
  } else {
    verdict = Math.abs(value) <= 0.05
      ? 'Your eleven projects the same as it did before.'
      : `Your eleven projects ${signed(value)} points this gameweek.`;
  }

  return el('p', { class: `fpl-verdict ${tone}`.trim() }, [
    el('b', { text: verdict }),
    // A transfer changes both, so the gameweek number is worth stating too
    // rather than leaving the manager to subtract it out of the strip.
    movedSquad && Math.abs(c.gw.delta) > 0.05 ? ` This gameweek alone: ${signed(c.gw.delta)}.` : '',
    c.captainChanged ? ' The armband moved too.' : '',
  ]);
}

/* --------------------------------------------------------------- action bar */

// What can be done to the selected player, as labelled buttons. The bar sits in
// the flow under the pitch rather than floating over it: a popover pinned to a
// card that may be halfway off a phone screen is a positioning problem with no
// good answer, and this needs none.
function actionBar({ scenario, ctx, selection, gameState, onAction, onPlayerDetails }) {
  if (!selection) {
    return el('p', { class: 'fpl-note fpl-sandbox-hint', text: 'Choose a player to swap him, sell him, or give him the armband.' });
  }
  const info = describePlayer(gameState, selection.playerId);
  const starting = scenario.xi.includes(selection.playerId);
  const isBenchGk = scenario.benchGk === selection.playerId;
  const benchIndex = scenario.benchOrder.indexOf(selection.playerId);

  if (selection.mode === 'swap') {
    return el('div', { class: 'fpl-actionbar is-swapping' }, [
      el('div', { class: 'fpl-actionbar-who' }, [
        el('b', { text: info.name }),
        el('span', { text: ' selected. Choose who he changes places with.' }),
      ]),
      btn('Cancel', () => onAction('cancel'), { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' }),
    ]);
  }

  // Two groups, because they are two kinds of action: the ones that CHANGE the
  // squad, and the ones that leave it alone. Grouping them in the markup rather
  // than with a margin trick is what keeps them apart once the row wraps.
  const changes = [];
  changes.push(btn(starting ? 'Swap with a substitute' : 'Swap into the eleven',
    () => onAction('swap-start', { playerId: selection.playerId }),
    { variant: 'fpl-btn-primary', size: 'fpl-btn-sm' }));
  changes.push(btn('Transfer out', () => onAction('transfer-open', { playerId: selection.playerId }), { size: 'fpl-btn-sm' }));

  if (starting) {
    if (scenario.captain !== selection.playerId) {
      changes.push(btn('Make captain', () => onAction('captain', { playerId: selection.playerId }), { size: 'fpl-btn-sm' }));
    }
    if (scenario.viceCaptain !== selection.playerId) {
      changes.push(btn('Make vice', () => onAction('vice', { playerId: selection.playerId }), { size: 'fpl-btn-sm' }));
    }
  }
  if (!starting && !isBenchGk) {
    if (benchIndex > 0) changes.push(btn('Move up the bench', () => onAction('bench-up', { playerId: selection.playerId }), { size: 'fpl-btn-sm' }));
    if (benchIndex < scenario.benchOrder.length - 1) {
      changes.push(btn('Move down the bench', () => onAction('bench-down', { playerId: selection.playerId }), { size: 'fpl-btn-sm' }));
    }
  }

  const aside = [
    btn('Player details', () => onPlayerDetails(selection.playerId), { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' }),
    btn('Done', () => onAction('cancel'), { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' }),
  ];

  return el('div', { class: 'fpl-actionbar' }, [
    el('div', { class: 'fpl-actionbar-who' }, [
      el('b', { text: info.name }),
      el('span', { text: ` · ${info.club} · ${info.positionShort} · ${formatMoney(info.priceTenths)} · ${starting ? 'starting' : 'on the bench'}` }),
    ]),
    el('div', { class: 'fpl-actionbar-actions' }, [
      el('div', { class: 'fpl-actionbar-group' }, changes),
      el('div', { class: 'fpl-actionbar-group is-aside' }, aside),
    ]),
  ]);
}

/* ------------------------------------------------------------ transfer picker */

// The replacement list. Blocked options stay visible with their reason, because
// hiding an unaffordable player answers "why can I not find him" with silence.
export function transferPicker({ scenario, ctx, outId, projections, gw, onPick, onCancel }) {
  const { gameState } = ctx;
  const out = describePlayer(gameState, outId);
  const rows = transferCandidates(scenario, ctx, outId, { projections, gw });
  const message = el('div', { class: 'fpl-picker-msg', role: 'status', 'aria-live': 'polite' });

  const items = rows.map(r => ({
    id: r.id,
    label: r.name,
    // Club and price are part of the identity, not decoration: two players can
    // share a display name (the live payload has two called Sangare, at
    // different clubs and different prices), so a row without them is ambiguous.
    meta: `${r.club} · ${formatMoney(r.priceTenths)}${r.blocked ? ' · ' + r.blocked : ''}`,
    trailing: r.xPoints === null ? '-' : `${r.xPoints.toFixed(1)} xP`,
    search: `${r.name} ${r.club} ${r.clubName}`.toLowerCase(),
    blocked: r.blocked,
  }));

  const box = combobox({
    items,
    label: `Replacement for ${out.name}`,
    placeholder: 'Search by player or club',
    emptyText: 'No player of that position matches.',
    onSelect: (item) => {
      const blocked = item && item.blocked;
      if (blocked) {
        message.textContent = blocked;
        message.classList.add('is-bad');
        return;
      }
      onPick(item.id);
    },
  });

  // Open onto the ranked list as soon as the picker is on screen, rather than
  // showing an empty box that only reveals itself once the user guesses that
  // typing is required. The timeout is what puts this after the node is
  // attached; preventScroll keeps the pitch where the user left it.
  const node = el('div', { class: 'fpl-picker' });
  setTimeout(() => {
    try {
      if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
      box.input.focus({ preventScroll: true });
      box.open('');
    } catch { /* the picker was closed again before this ran */ }
  }, 0);

  return append(node, [
    el('div', { class: 'fpl-picker-head' }, [
      el('div', {}, [
        el('b', { text: `Replace ${out.name}` }),
        el('span', { class: 'fpl-note', text: ` · sells for ${formatMoney(sellTenthsFor(scenario, ctx, outId))}` }),
      ]),
      btn('Cancel', onCancel, { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' }),
    ]),
    box.node,
    message,
  ]);
}

/* -------------------------------------------------------------------- view */

export function renderSandbox({
  scenario, ctx, projections, gw, horizon, discount, showXp, selection,
  onAction, onPlayerDetails, picker,
}) {
  const { gameState } = ctx;
  const summary = scenarioSummary(scenario, ctx, { projections, gw, horizon, discount });
  const positionOf = id => {
    const p = rawPlayer(gameState, id);
    return p ? p.position : 0;
  };
  const formation = scenario.xi.length ? formationOf(scenario.xi, positionOf, gameState.rules) : '';
  const rows = pitchRows(scenario.xi, formation, positionOf) || [scenario.xi];

  // When a swap is in progress every other player is a target, and each one
  // carries its own answer to "can this happen", so a refusal is explained
  // where the user is looking.
  const targetFor = (id) => {
    if (!selection || selection.mode !== 'swap' || id === selection.playerId) return null;
    const a = selection.playerId;
    const bothStarting = scenario.xi.includes(a) && scenario.xi.includes(id);
    const bothBench = !scenario.xi.includes(a) && !scenario.xi.includes(id);
    if (bothStarting) return { blocked: 'Both are already starting.' };
    if (bothBench && (a === scenario.benchGk || id === scenario.benchGk)) {
      return { blocked: 'The reserve goalkeeper has his own slot.' };
    }
    return { blocked: swapBlockedReason(scenario, ctx, a, id) };
  };

  const cardFor = (id, extra = {}) => editableCard({
    playerId: id, gameState, projections, gw, horizon, scenario, showXp,
    selection, targetInfo: targetFor(id),
    onSelect: (playerId) => onAction('select', { playerId }),
    ...extra,
  });

  const pitch = el('div', { class: 'fpl-pitch fpl-pitch-edit' },
    rows.map(ids => el('div', { class: 'fpl-row' }, ids.map(id => cardFor(id)))));

  const bench = el('div', { class: 'fpl-bench' }, [
    el('div', { class: 'fpl-bench-title', text: 'Bench, in auto-sub order' }),
    el('div', { class: 'fpl-bench-row' }, [
      scenario.benchGk ? cardFor(scenario.benchGk, { benchNumber: 0, isBenchGk: true }) : null,
      ...scenario.benchOrder.map((id, i) => cardFor(id, { benchNumber: i + 1 })),
    ]),
  ]);

  // What the user changed, against what this scenario started from. Before the
  // first deadline that is the built fifteen and the changes are not transfers,
  // so the list is titled for what it actually is rather than charging the
  // manager language he has not earned.
  const diff = seedDiff(scenario);
  const freshBuild = isFreshBuild(ctx.squadState);
  const nameOf = id => describePlayer(gameState, id).name;
  const moves = diff.out.map((outId, i) => el('li', {}, [
    el('span', { class: 'fpl-move-out', text: nameOf(outId) }),
    el('span', { class: 'fpl-move-arrow', text: ' → ' }),
    el('span', { class: 'fpl-move-in', text: diff.in[i] ? nameOf(diff.in[i]) : '?' }),
  ]));
  const movesTitle = freshBuild
    ? `Changes to your opening fifteen (${moves.length})`
    : `Transfers in this scenario (${moves.length})`;

  return el('div', { class: 'fpl-sandbox' }, [
    // The state banner is not decoration. Three squads exist in this app and
    // confusing them is the one failure this feature must not have, so the
    // scenario says what it is every time it is on screen.
    el('div', { class: `fpl-scenario-flag ${summary.dirty ? 'is-edited' : ''}`.trim() }, [
      el('b', {
        text: summary.dirty
          ? 'This is your edited scenario'
          // Before the first deadline there is no squad to have imported, so
          // calling the opening fifteen "your team" would be the app inventing
          // a fact about the manager's account.
          : scenario.origin === 'recommended'
            ? 'This is the opening fifteen the planner built, ready to edit'
            : 'This is your team, ready to edit',
      }),
      el('span', {
        text: summary.dirty
          ? ' It is not your FPL squad and nothing here is sent to Fantasy Premier League.'
          : ' Nothing here is sent to Fantasy Premier League.',
      }),
    ]),

    !summary.ok
      ? banner({
        tone: 'warn', mark: '!', title: 'This team is not legal yet',
        text: summary.reason || 'Something about this squad breaks an FPL rule.',
      })
      : null,

    comparisonStrip(summary, { horizon }),
    verdictLine(summary, horizon),

    moves.length ? disclosure(movesTitle, el('ul', { class: 'fpl-moves' }, moves), { open: true }) : null,

    el('div', { class: 'fpl-note', style: 'margin:14px 0 10px' }, [
      'Lining up ', el('b', { text: formation || 'no formation yet' }),
      `. Expected points are for Gameweek ${gw}.`,
    ]),
    pitch,
    bench,
    // The picker takes the action bar's place rather than sitting above the
    // pitch. The press that opens it happens down here, and a panel that opens
    // a screen and a half above the button that summoned it reads as nothing
    // having happened at all.
    picker || actionBar({ scenario, ctx, selection, gameState, onAction, onPlayerDetails }),
  ]);
}

// Whether two players can change places, answered by TRYING it against the real
// gate and throwing the result away. That costs one validation per target, and
// it buys the guarantee that what the pitch marks as possible and what the
// commit actually allows can never disagree.
function swapBlockedReason(scenario, ctx, aId, bId) {
  return swapPlayers(scenario, ctx, aId, bId).error;
}
