// The player detail drawer: click any player, get the numbers behind him.
//
// Everything shown is already in the browser: the normalized player record
// (price, ownership, season totals, news), the projection rows the plan was
// computed from (per-gameweek xPoints, expected minutes, start probability and
// the per-component points breakdown), and the fixture list. Nothing is
// fetched and nothing is recomputed; this is a reading of the plan's own
// inputs, so the drawer can never disagree with the plan.
//
// Accessibility: a modal dialog. Focus moves to the close button on open and
// returns to the element that opened it on close; Escape and the backdrop both
// close it; focus is trapped inside while open. The panel lives INSIDE the app
// root wrapper so app CSS reaches it (DOM containment rather than z-index
// games against shared chrome).

import { el, clear } from './dom.js';
import { formatMoney, xp, percent } from './format.js';
import { describePlayer, getProjection, availability, fixtureLabel } from './plan-model.js';
import { sparkline } from './charts.js';
import { lockScroll, unlockScroll } from './scroll-lock.js';

const BREAKDOWN_LABELS = {
  appearance: 'Appearance',
  goals: 'Goals',
  assists: 'Assists',
  cleanSheets: 'Clean sheets',
  conceded: 'Goals conceded',
  saves: 'Saves',
  penaltySaves: 'Penalty saves',
  defcon: 'Defensive contribution',
  bonus: 'Bonus',
  cards: 'Cards',
};

function rawPlayer(gameState, id) {
  return gameState.players instanceof Map ? gameState.players.get(id) : null;
}

function statCell(label, value, note = null) {
  return el('div', { class: 'fpl-dw-stat' }, [
    el('div', { class: 'fpl-fact-k', text: label }),
    el('div', { class: 'fpl-dw-stat-v', text: value }),
    note ? el('div', { class: 'fpl-fact-note', text: note }) : null,
  ]);
}

// The per-component breakdown for one gameweek, as quiet meters. Negative
// components (cards, goals conceded) render on the red side so the story stays
// honest: an xP total is what is left AFTER them.
function breakdownList(row) {
  const entries = Object.entries(row.pointsBreakdown || {})
    .filter(([, v]) => Number.isFinite(v) && Math.abs(v) >= 0.05)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (!entries.length) return null;
  const maxAbs = Math.max(...entries.map(([, v]) => Math.abs(v)));
  return el('div', { class: 'fpl-dw-breakdown' }, entries.map(([key, v]) => el('div', { class: 'fpl-dw-bd-row' }, [
    el('span', { class: 'fpl-dw-bd-k', text: BREAKDOWN_LABELS[key] || key }),
    el('span', { class: 'fpl-dw-bd-track' }, el('span', {
      class: `fpl-dw-bd-fill ${v < 0 ? 'is-neg' : ''}`.trim(),
      style: `width:${Math.max(4, (Math.abs(v) / maxAbs) * 100)}%`,
    })),
    el('span', { class: `fpl-dw-bd-v ${v < 0 ? 'is-neg' : ''}`.trim(), text: `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(1)}` }),
  ])));
}

// The heading over a player's season totals.
export function seasonTotalsLabel(evidence) {
  if (evidence && evidence.kind === 'previous-season') return 'Last season';
  if (evidence && evidence.kind === 'none') return 'Season totals (not published yet)';
  return 'Season so far';
}

function drawerContent({ playerId, gameState, projections, gw, horizon, evidence = null }) {
  const info = describePlayer(gameState, playerId);
  const player = rawPlayer(gameState, playerId);
  const avail = player ? availability(player) : null;

  const gwRows = [];
  for (let k = 0; k < horizon; k++) {
    const row = getProjection(projections, playerId, gw + k);
    if (row) gwRows.push(row);
  }
  const thisGw = gwRows[0] || null;

  const header = el('header', { class: 'fpl-dw-head' }, [
    el('div', { class: `fpl-dw-posband pos-${info.position}`, 'aria-hidden': 'true' }),
    el('div', { class: 'fpl-dw-title' }, [
      el('h3', { text: info.name }),
      el('div', { class: 'fpl-dw-sub' }, [
        el('span', { text: `${info.clubName || info.club} · ${info.positionShort} · ${formatMoney(info.priceTenths)}` }),
        avail ? el('span', { class: `fpl-chip ${avail.kind === 'out' ? 'is-inj' : 'is-doubt'}`, text: avail.label }) : null,
      ]),
    ]),
  ]);

  const news = avail && avail.news
    ? el('p', { class: 'fpl-dw-news', text: avail.news })
    : null;

  const projection = gwRows.length ? el('section', { class: 'fpl-dw-section' }, [
    el('div', { class: 'fpl-subhead', text: `Projected over the next ${gwRows.length} gameweeks` }),
    gwRows.length >= 2 ? sparkline({ values: gwRows.map(r => r.xPoints), height: 44 }) : null,
    el('div', { class: 'fpl-dw-gws' }, gwRows.map(row => el('div', { class: `fpl-dw-gw ${row.fixtures.length === 0 ? 'is-blank' : ''}`.trim() }, [
      el('span', { class: 'fpl-dw-gw-k', text: `GW ${row.gw}` }),
      el('span', { class: 'fpl-dw-gw-v', text: `${xp(row.xPoints)} xP` }),
      el('span', { class: 'fpl-dw-gw-f', text: fixtureLabel(row, gameState) }),
    ]))),
  ]) : null;

  const minutes = thisGw ? el('section', { class: 'fpl-dw-section' }, [
    el('div', { class: 'fpl-subhead', text: `This gameweek` }),
    el('div', { class: 'fpl-dw-stats' }, [
      statCell('Expected points', xp(thisGw.xPoints), thisGw.ceiling ? `Ceiling ${xp(thisGw.ceiling)}` : null),
      statCell('Chance of starting', percent(thisGw.pStart)),
      statCell('Expected minutes', String(Math.round(thisGw.xMins))),
      statCell('Fixture', fixtureLabel(thisGw, gameState)),
    ]),
    breakdownList(thisGw) ? el('div', {}, [
      el('div', { class: 'fpl-subhead', text: 'Where the points come from' }),
      breakdownList(thisGw),
    ]) : null,
  ]) : null;

  const season = player ? el('section', { class: 'fpl-dw-section' }, [
    // Which season these totals describe is decided by seasonEvidence(), not
    // assumed: before FPL clears them they are LAST season's, and calling them
    // "season so far" in August is the app stating something untrue.
    el('div', { class: 'fpl-subhead', text: seasonTotalsLabel(evidence) }),
    el('div', { class: 'fpl-dw-stats' }, [
      statCell('Points', String(player.totalPoints ?? 0)),
      statCell('Minutes', (player.minutes ?? 0).toLocaleString('en-GB'), Number.isFinite(player.starts) ? `${player.starts} starts` : null),
      statCell('Goals', String(player.goalsScored ?? 0)),
      statCell('Assists', String(player.assists ?? 0)),
      statCell('Clean sheets', String(player.cleanSheets ?? 0)),
      statCell('Bonus', String(player.bonus ?? 0)),
      Number.isFinite(player.xG) ? statCell('xG', player.xG.toFixed(1)) : null,
      Number.isFinite(player.xA) ? statCell('xA', player.xA.toFixed(1)) : null,
      Number.isFinite(player.selectedByPercent) ? statCell('Ownership', `${player.selectedByPercent.toFixed(1)}%`) : null,
    ]),
  ]) : null;

  return [header, news, projection, minutes, season];
}

// One drawer per app. `context()` is read at open time so the drawer always
// reflects the bundle currently on screen.
export function createPlayerDrawer({ root, context }) {
  let node = null;
  let lastFocus = null;

  function close() {
    if (!node) return;
    node.remove();
    node = null;
    // Paired with the lockScroll() in open(): the page unlocks (and returns
    // to its exact previous scroll offset) however the drawer was dismissed -
    // the X, the backdrop, Escape, or a re-render tearing it down.
    unlockScroll();
    document.removeEventListener('keydown', onKeydown, true);
    // preventScroll: returning focus must not scroll the page the lock just
    // restored - the offset the user left at is part of the contract.
    if (lastFocus && typeof lastFocus.focus === 'function' && lastFocus.isConnected) {
      try { lastFocus.focus({ preventScroll: true }); } catch { lastFocus.focus(); }
    }
    lastFocus = null;
  }

  function onKeydown(event) {
    if (!node) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // Focus stays inside the dialog while it is open.
      const focusable = node.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  function open(playerId, { trigger = null } = {}) {
    const ctx = context();
    if (!ctx) return;
    lastFocus = trigger || document.activeElement;
    if (!node) {
      node = el('div', { class: 'fpl-dw-overlay' });
      root.appendChild(node);
      document.addEventListener('keydown', onKeydown, true);
      // Lock exactly once per overlay lifetime: opening another player while
      // the drawer is already up reuses the node and must not lock again.
      lockScroll();
    }
    clear(node);
    const closeBtn = el('button', {
      type: 'button',
      class: 'fpl-dw-close',
      'aria-label': 'Close player details',
      onclick: close,
    }, el('i', { class: 'fa-solid fa-xmark', 'aria-hidden': 'true' }));
    const info = describePlayer(ctx.gameState, playerId);
    const panel = el('aside', {
      class: 'fpl-dw',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `${info.name}: player details`,
    }, [closeBtn, ...drawerContent({ playerId, ...ctx })]);
    node.append(
      el('div', { class: 'fpl-dw-backdrop', onclick: close }),
      panel,
    );
    try { closeBtn.focus({ preventScroll: true }); } catch { closeBtn.focus(); }
  }

  return { open, close };
}
