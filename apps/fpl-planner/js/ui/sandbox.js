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
//   1. Activate a player. He becomes selected and the action dock (pinned near
//      the bottom of the viewport, so it is visible wherever the player was)
//      offers everything that can be done to him, each button labelled.
//   2. "Swap" turns every other player into a target. Legal targets are marked;
//      choosing an illegal one explains why in the dock instead of ignoring
//      the press.
//
// Every step is a button, so the keyboard gets it free, screen readers announce
// it, and the same code runs on a phone and a desktop.
//
// THE RENDERING MODEL, AND WHY IT IS NOT "REBUILD EVERYTHING"
//
// This view is created ONCE and then updated in place. The first version
// re-rendered the whole app on every click, and that is what made the feature
// feel broken: replacing the entire DOM defeats the browser's scroll anchoring
// (the page jumped hundreds of pixels on an ordinary click), throws keyboard
// focus back to <body>, and repaints every card the user is looking at.
//
// So `createSandboxView` builds a stable skeleton of slots and `update(props)`
// diffs coarsely on OBJECT IDENTITY, which is exact here because every scenario
// edit returns a new scenario object:
//
//   - scenario / projections / showXp changed  -> rebuild the squad-dependent
//     slots (summary strip, verdict, moves, pitch, bench). One edit, one
//     scoped rebuild.
//   - only the selection changed               -> toggle classes on the
//     existing cards and redraw the dock. No card is destroyed, so focus and
//     scroll cannot move.
//   - only the picker / error / busy changed   -> redraw the dock or the plan
//     slot alone.
//
// This is not a framework: it is one function with named slots, and the
// discipline that state lives in app.js and flows down through update().

import { el, append, disclosure } from './dom.js';
import { formatMoney, xp } from './format.js';
import { btn, banner } from './parts.js';
import { describePlayer, fixtureLabel, availability, getProjection, pitchRows } from './plan-model.js';
import { formationOf } from '../engine/validate.js';
import {
  scenarioSummary, transferCandidates, swapPlayers, sellTenthsFor, seedDiff, isFreshBuild, canUndo,
} from './scenario.js';
import { combobox } from './combobox.js';

const rawPlayer = (gameState, id) => (gameState.players instanceof Map ? gameState.players.get(id) : null);
const signed = (n, digits = 1) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${Math.abs(n).toFixed(digits)}`;

// className helpers that work in the browser and under the test mini DOM.
function setClass(node, cls, on) {
  const set = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
  if (on) set.add(cls); else set.delete(cls);
  node.className = [...set].join(' ');
}

const within = (node, container) => {
  for (let n = node; n; n = n.parentNode) if (n === container) return true;
  return false;
};

// Focus without scrolling: the page must stay exactly where the user left it,
// which is the scroll-lock lesson applied to every programmatic focus here.
function tryFocus(node) {
  if (!node || typeof node.focus !== 'function') return;
  try { node.focus({ preventScroll: true }); } catch { node.focus(); }
}

/* ------------------------------------------------------------ player card */

// The sandbox draws its own card rather than reusing pitch.js's, because an
// editable card is a different control: it carries selection and target state,
// an optional projection detail block, and it must never be mistaken for the
// read-only pitch sitting one tab away.
function editableCard({
  playerId, gameState, projections, gw, horizon, scenario, showXp,
  onSelect, benchNumber = null, isBenchGk = false,
}) {
  const info = describePlayer(gameState, playerId);
  const row = getProjection(projections, playerId, gw);
  const avail = availability(rawPlayer(gameState, playerId));
  const fixtures = row && Array.isArray(row.fixtures) ? row.fixtures : [];

  const classes = ['fpl-pp', 'fpl-pp-edit', `pos-${info.position}`];
  if (avail && avail.kind === 'out') classes.push('is-injured');
  if (avail && avail.kind === 'doubt') classes.push('is-doubtful');
  if (row && fixtures.length === 0) classes.push('is-blank');

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

  const baseLabel = `${info.name}, ${info.positionShort}, ${formatMoney(info.priceTenths)}: choose an action`;
  const node = el('div', {
    class: classes.join(' '),
    tabindex: '0',
    role: 'button',
    'aria-pressed': 'false',
    'aria-label': baseLabel,
    dataset: { playerId: String(playerId) },
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
  ]);
  node.fplBaseLabel = baseLabel;
  node.fplName = info.name;

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

// What can be done to the selected player, as labelled buttons. The bar lives
// in the dock: in the flow after the bench, pinned near the bottom of the
// viewport while its natural place is off screen, so it appears in the same
// spot whichever card was pressed. A popover pinned to a card that may be
// halfway off a phone screen is a positioning problem with no good answer, and
// this needs none.
function actionBar({ scenario, selection, gameState, onAction, onPlayerDetails }) {
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
//
// It renders into the dock, where the "Transfer out" button that summoned it
// was, so the flow reads as one continuous operation. The dock is pinned near
// the viewport bottom, so no scrolling is needed to find it: the page is not
// moved at all.
function transferPicker({ scenario, ctx, outId, projections, gw, onPick, onCancel }) {
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

  const node = el('div', { class: 'fpl-picker' });
  // Open onto the ranked list as soon as the picker is on screen, rather than
  // showing an empty box that only reveals itself once the user guesses that
  // typing is required. The timeout is what puts this after the node is
  // attached; preventScroll keeps the page exactly where it is. The dock's own
  // pinning is what makes the picker visible, so nothing here scrolls.
  setTimeout(() => {
    try {
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

/* ------------------------------------------------------- scenario plan card */

// What the planner says when it starts from the edited squad. Labelled as a
// hypothetical everywhere it appears, because the whole risk of this feature is
// a user reading it as advice about the team they actually own.
function scenarioPlanCard({ scenarioBundle, ctx }) {
  const plan = scenarioBundle.current;
  const nameOf = (id) => {
    const p = rawPlayer(ctx.gameState, id);
    return p ? p.webName : `Player ${id}`;
  };
  const pairs = (plan.transfersOut || []).map((outId, i) => `${nameOf(outId)} out, ${nameOf((plan.transfersIn || [])[i])} in`);
  const stat = (label, value) => el('div', {}, [
    el('div', { class: 'fpl-stat-k', text: label }),
    el('div', { class: 'fpl-stat-v', text: value }),
  ]);
  return el('section', { class: 'fpl-card fpl-scenario-plan' }, [
    el('div', { class: 'fpl-card-head' }, [
      el('h3', { text: 'The planner, starting from your scenario' }),
    ]),
    el('div', { class: 'fpl-card-body' }, [
      el('p', { class: 'fpl-note' }, [
        'This is advice about ',
        el('b', { text: 'your edited team' }),
        ', not about the squad you own in Fantasy Premier League.',
      ]),
      el('p', { class: 'fpl-verdict' }, [el('b', { text: plan.explanation ? plan.explanation.headline : 'Plan ready' })]),
      pairs.length
        ? el('ul', { class: 'fpl-moves' }, pairs.map(t => el('li', { text: t })))
        : el('p', { class: 'fpl-note', text: 'It would make no further transfer from here.' }),
      el('div', { class: 'fpl-kv' }, [
        stat('Captain', nameOf(plan.captain)),
        stat('This gameweek', `${plan.xPointsGw.toFixed(1)} xP`),
        stat(`Next ${plan.horizon} gameweeks`, `${plan.xPointsHorizon.toFixed(1)} xP`),
        stat('Hit', plan.hitCostPoints ? `-${plan.hitCostPoints}` : 'none'),
      ]),
    ]),
  ]);
}

/* --------------------------------------------------------------------- view */

// Whether two players can change places, answered by TRYING it against the real
// gate and throwing the result away. That costs one validation per target, and
// it buys the guarantee that what the pitch marks as possible and what the
// commit actually allows can never disagree.
function swapBlockedReason(scenario, ctx, aId, bId) {
  return swapPlayers(scenario, ctx, aId, bId).error;
}

// The target state of one card while a swap is in progress, so a refusal can be
// phrased before the press (for assistive tech) and marked on the card.
function targetInfoFor(scenario, ctx, selection, id) {
  if (!selection || selection.mode !== 'swap' || id === selection.playerId) return null;
  const a = selection.playerId;
  const bothStarting = scenario.xi.includes(a) && scenario.xi.includes(id);
  const bothBench = !scenario.xi.includes(a) && !scenario.xi.includes(id);
  if (bothStarting) return { blocked: 'Both are already starting.' };
  if (bothBench && (a === scenario.benchGk || id === scenario.benchGk)) {
    return { blocked: 'The reserve goalkeeper has his own slot.' };
  }
  return { blocked: swapBlockedReason(scenario, ctx, a, id) };
}

export function createSandboxView({ onAction, onPlayerDetails }) {
  let prev = null;      // the props of the last update, for identity diffing
  let summary = null;   // scenarioSummary for the current structural state
  let pickerUi = null;  // the open picker's node, reused across updates
  let movesOpen = true; // the user's disclosure choice, preserved across edits
  const cards = new Map(); // playerId -> card node, for in-place class updates

  /* -------- the stable skeleton; every update writes into these slots ---- */

  const tb = {
    xp: btn('Show expected points', () => onAction('toggle-xp'), { size: 'fpl-btn-sm' }),
    undo: btn('Undo', () => onAction('undo'), { size: 'fpl-btn-sm' }),
    reset: btn('Reset to my team', () => onAction('reset'), { size: 'fpl-btn-sm' }),
    copy: btn('Start from the recommendation', () => onAction('copy-recommended'), { size: 'fpl-btn-sm' }),
    ask: btn('Ask the planner from this team', () => onAction('recommend'), { variant: 'fpl-btn-primary', size: 'fpl-btn-sm' }),
  };
  const toolbar = el('div', { class: 'fpl-sandbox-tools' }, [tb.xp, tb.undo, tb.reset, tb.copy, tb.ask]);

  const slots = {
    flag: el('div', { class: 'fpl-scenario-flag' }),
    legal: el('div', {}),
    compare: el('div', {}),
    verdict: el('div', {}),
    moves: el('div', {}),
    note: el('div', { class: 'fpl-note', style: 'margin:14px 0 10px' }),
    pitch: el('div', { class: 'fpl-pitch fpl-pitch-edit' }),
    bench: el('div', { class: 'fpl-bench' }),
    dock: el('div', { class: 'fpl-dock' }),
    plan: el('div', {}),
  };

  // The verdict and the moves list sit BELOW the pitch on purpose, for two
  // reasons that are really one. Everything above the pitch keeps a stable
  // height, so an edit can never push the cards the user is looking at down
  // the page (the moves list used to sit above and the first transfer moved
  // the whole pitch 133px; the verdict wrapping to an extra line moved it
  // 22px on a phone). And both are REACTIONS to an edit, so they belong next
  // to the dock where the edit was made, not a screen above it.
  const sandboxEl = el('div', { class: 'fpl-sandbox' }, [
    slots.flag, slots.legal, slots.compare,
    slots.note, slots.pitch, slots.bench, slots.verdict, slots.moves, slots.dock,
  ]);
  const root = el('div', {}, [toolbar, sandboxEl, slots.plan]);

  /* ----------------------------------------------------- slot renderers --- */

  function renderFlag(props) {
    const dirty = summary.dirty;
    setClass(slots.flag, 'is-edited', dirty);
    slots.flag.replaceChildren(
      el('b', {
        text: dirty
          ? 'This is your edited scenario'
          // Before the first deadline there is no squad to have imported, so
          // calling the opening fifteen "your team" would be the app inventing
          // a fact about the manager's account.
          : props.scenario.origin === 'recommended'
            ? 'This is the opening fifteen the planner built, ready to edit'
            : 'This is your team, ready to edit',
      }),
      el('span', {
        text: dirty
          ? ' It is not your FPL squad and nothing here is sent to Fantasy Premier League.'
          : ' Nothing here is sent to Fantasy Premier League.',
      }),
    );
  }

  function renderLegal() {
    slots.legal.replaceChildren(...(summary.ok ? [] : [banner({
      tone: 'warn', mark: '!', title: 'This team is not legal yet',
      text: summary.reason || 'Something about this squad breaks an FPL rule.',
    })]));
  }

  function renderMoves(props) {
    // What the user changed, against what this scenario started from. Before
    // the first deadline that is the built fifteen and the changes are not
    // transfers, so the list is titled for what it actually is rather than
    // charging the manager language he has not earned.
    const diff = seedDiff(props.scenario);
    const nameOf = id => describePlayer(props.ctx.gameState, id).name;
    const moves = diff.out.map((outId, i) => el('li', {}, [
      el('span', { class: 'fpl-move-out', text: nameOf(outId) }),
      el('span', { class: 'fpl-move-arrow', text: ' → ' }),
      el('span', { class: 'fpl-move-in', text: diff.in[i] ? nameOf(diff.in[i]) : '?' }),
    ]));
    if (!moves.length) {
      slots.moves.replaceChildren();
      return;
    }
    const title = isFreshBuild(props.ctx.squadState)
      ? `Changes to your opening fifteen (${moves.length})`
      : `Transfers in this scenario (${moves.length})`;
    const d = disclosure(title, el('ul', { class: 'fpl-moves' }, moves), { open: movesOpen });
    // <details> is browser-owned state; remember the user's choice so the next
    // edit does not silently re-open what they closed.
    d.addEventListener('toggle', () => { movesOpen = !!d.open; });
    slots.moves.replaceChildren(d);
  }

  function renderNote(props) {
    const { gameState } = props.ctx;
    const positionOf = id => {
      const p = rawPlayer(gameState, id);
      return p ? p.position : 0;
    };
    const formation = props.scenario.xi.length
      ? formationOf(props.scenario.xi, positionOf, gameState.rules)
      : '';
    slots.note.replaceChildren(
      'Lining up ', el('b', { text: formation || 'no formation yet' }),
      `. Expected points are for Gameweek ${props.gw}.`,
    );
  }

  function renderPitch(props, enteringIds) {
    const { gameState } = props.ctx;
    const positionOf = id => {
      const p = rawPlayer(gameState, id);
      return p ? p.position : 0;
    };
    const sc = props.scenario;
    const formation = sc.xi.length ? formationOf(sc.xi, positionOf, gameState.rules) : '';
    const rows = pitchRows(sc.xi, formation, positionOf) || [sc.xi];

    // Keyboard continuity: if focus is on a card that is about to be rebuilt,
    // put it back on the same player's new card afterwards.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const activeId = active && active.dataset && active.dataset.playerId ? active.dataset.playerId : null;

    cards.clear();
    const cardFor = (id, extra = {}) => {
      const node = editableCard({
        playerId: id, gameState, projections: props.projections, gw: props.gw,
        horizon: props.horizon, scenario: sc, showXp: props.showXp,
        onSelect: (playerId) => onAction('select', { playerId }),
        ...extra,
      });
      const cardNode = extra.benchNumber !== null && extra.benchNumber !== undefined
        ? node.childNodes[node.childNodes.length - 1]
        : node;
      cards.set(id, cardNode);
      if (enteringIds && enteringIds.has(id)) setClass(cardNode, 'is-just-in', true);
      return node;
    };

    slots.pitch.replaceChildren(
      ...rows.map(ids => el('div', { class: 'fpl-row' }, ids.map(id => cardFor(id)))),
    );
    slots.bench.replaceChildren(
      el('div', { class: 'fpl-bench-title', text: 'Bench, in auto-sub order' }),
      el('div', { class: 'fpl-bench-row' }, [
        sc.benchGk ? cardFor(sc.benchGk, { benchNumber: 0, isBenchGk: true }) : null,
        ...sc.benchOrder.map((id, i) => cardFor(id, { benchNumber: i + 1 })),
      ].filter(Boolean)),
    );

    if (activeId && cards.has(Number(activeId))) tryFocus(cards.get(Number(activeId)));
  }

  // Selection and swap-target state, applied to the EXISTING cards. No card is
  // created or destroyed here, which is what keeps focus and scroll still.
  function paintSelection(props) {
    const sel = props.selection;
    for (const [id, node] of cards) {
      const isSelected = !!sel && sel.playerId === id;
      const info = targetInfoFor(props.scenario, props.ctx, sel, id);
      const isTarget = !!info;
      const isBlocked = isTarget && !!info.blocked;
      setClass(node, 'is-selected', isSelected);
      setClass(node, 'is-target', isTarget && !isBlocked);
      setClass(node, 'is-target-blocked', isBlocked);
      node.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      node.setAttribute('aria-label', isTarget
        ? `${node.fplName}: ${isBlocked ? 'cannot swap, ' + info.blocked : 'swap with the selected player'}`
        : node.fplBaseLabel);
    }
  }

  function renderDock(props) {
    // If focus is inside the dock (the user pressed one of its buttons), find
    // the same-labelled control in the rebuilt dock and put focus back.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const focusLabel = active && within(active, slots.dock) && active.tagName === 'BUTTON'
      ? active.textContent : null;

    const parts = [];
    let live = false;
    if (props.picker) {
      live = true;
      // Cached so unrelated updates cannot eat the typed search, but rebuilt
      // whenever the squad it was priced against changes: candidates carry
      // affordability, and a list priced against a stale bank would lie.
      if (!pickerUi || pickerUi.key !== props.picker
        || pickerUi.scenario !== props.scenario || pickerUi.squadState !== props.ctx.squadState) {
        pickerUi = {
          key: props.picker,
          scenario: props.scenario,
          squadState: props.ctx.squadState,
          node: transferPicker({
            scenario: props.scenario,
            ctx: props.ctx,
            outId: props.picker.outId,
            projections: props.projections,
            gw: props.gw,
            onPick: (playerId) => onAction('transfer-pick', { playerId }),
            onCancel: () => onAction('cancel'),
          }),
        };
      }
      parts.push(pickerUi.node);
    } else {
      pickerUi = null;
      if (props.selection) {
        live = true;
        parts.push(actionBar({
          scenario: props.scenario,
          selection: props.selection,
          gameState: props.ctx.gameState,
          onAction,
          onPlayerDetails,
        }));
      } else {
        // The hint doubles as the place to take back the LAST edit, because
        // this is where the user is looking when an edit just completed. The
        // toolbar's Undo does the same thing from the top of the panel.
        parts.push(el('p', { class: 'fpl-note fpl-sandbox-hint' }, [
          'Choose a player to swap him, sell him, or give him the armband.',
          canUndo(props.scenario)
            ? btn('Undo last change', () => onAction('undo'), { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' })
            : null,
        ]));
      }
    }
    // A refusal is shown where the user is looking: in the dock, beside the
    // control that was pressed, in the validator's own words.
    if (props.error) {
      parts.push(el('div', { class: 'fpl-dock-msg is-bad', role: 'status', text: props.error }));
    }
    slots.dock.replaceChildren(...parts);
    setClass(slots.dock, 'is-live', live);

    if (focusLabel) {
      const again = findButton(slots.dock, focusLabel);
      if (again) tryFocus(again);
    }
  }

  function findButton(container, label) {
    const stack = [container];
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType === 1) {
        if (n.tagName === 'BUTTON' && n.textContent === label && !n.disabled) return n;
        for (const c of n.childNodes) stack.push(c);
      }
    }
    return null;
  }

  function renderPlanSlot(props) {
    if (props.busy) {
      slots.plan.replaceChildren(el('p', {
        class: 'fpl-note fpl-scenario-busy', role: 'status',
        text: 'Asking the planner from this team. The scenario above stays editable while it thinks.',
      }));
      return;
    }
    if (!props.scenarioBundle) {
      slots.plan.replaceChildren();
      return;
    }
    slots.plan.replaceChildren(scenarioPlanCard(props));
  }

  function renderToolbar(props) {
    tb.xp.textContent = props.showXp ? 'Hide expected points' : 'Show expected points';
    setClass(tb.xp, 'fpl-btn-primary', props.showXp);
    tb.undo.disabled = !canUndo(props.scenario);
    tb.reset.disabled = !summary.dirty;
    tb.ask.textContent = props.busy ? 'Asking the planner...' : 'Ask the planner from this team';
    tb.ask.disabled = !!props.busy;
  }

  /* --------------------------------------------------------------- update -- */

  function update(props) {
    const p = prev;
    const structural = !p
      || props.scenario !== p.scenario
      || props.ctx.squadState !== p.ctx.squadState
      || props.ctx.gameState !== p.ctx.gameState
      || props.projections !== p.projections
      || props.gw !== p.gw
      || props.horizon !== p.horizon
      || props.discount !== p.discount
      || props.showXp !== p.showXp;

    // Players this edit brought in, so "what changed" is visible on the pitch
    // itself for a moment, not only in the transfer list.
    const entering = structural && p && p.scenario && props.scenario !== p.scenario
      ? new Set(props.scenario.squad.filter(id => !p.scenario.squad.includes(id)))
      : null;

    if (structural) {
      // The one potentially expensive line, and it runs only when the squad
      // actually changed: a selection click re-renders nothing that needs it.
      summary = scenarioSummary(props.scenario, props.ctx, {
        projections: props.projections, gw: props.gw, horizon: props.horizon, discount: props.discount,
      });
      renderFlag(props);
      renderLegal();
      slots.compare.replaceChildren(comparisonStrip(summary, { horizon: props.horizon }));
      slots.verdict.replaceChildren(verdictLine(summary, props.horizon));
      renderMoves(props);
      renderNote(props);
      renderPitch(props, entering);
    }

    const selectionChanged = !p || props.selection !== p.selection;
    if (structural || selectionChanged) paintSelection(props);

    if (structural || selectionChanged
      || props.picker !== (p && p.picker)
      || props.error !== (p && p.error)) {
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      const dockHadFocus = !!active && within(active, slots.dock);
      renderDock(props);
      // Keyboard continuity: if the pressed dock control no longer exists (the
      // action completed, or the bar closed), focus moves to the card the
      // action was about instead of falling to <body>. A completed transfer
      // focuses the player who just came in.
      if (dockHadFocus) {
        const now = document.activeElement;
        if (!now || !within(now, slots.dock)) {
          const enteredId = entering && entering.size ? [...entering][0] : null;
          const sel = props.selection || (p && p.selection)
            || (p && p.picker ? { playerId: p.picker.outId } : null);
          if (enteredId !== null && cards.has(enteredId)) tryFocus(cards.get(enteredId));
          else if (sel && cards.has(sel.playerId)) tryFocus(cards.get(sel.playerId));
        }
      }
    }

    if (structural || !p || props.busy !== p.busy || props.scenarioBundle !== p.scenarioBundle) {
      renderPlanSlot(props);
    }

    renderToolbar(props);
    prev = props;
  }

  return { node: root, update };
}
