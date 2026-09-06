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
import { readPriceChange, upcomingDeadlines, PRICE_CHANGE_THRESHOLD } from '../engine/price-change.js';
import { dateTime } from './format.js';

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
//
// It has to name the season the numbers ACTUALLY belong to, and on 2026-08-21
// it did not: the classifier had mistaken a wiped payload for last season's,
// this heading followed it, and one match of the new season was presented as
// "Last season: 6 points, 90 minutes, 1 start". A heading derived from a
// misclassification repeats the misclassification with more authority.
//
// So it reads the two things that actually decide the answer: whether a kept
// baseline is standing in for the totals, and whether this season has started.
// When the app is projecting from a baseline the totals on screen are last
// season's; when it is not, they are this season's however few they are.
export function seasonTotalsLabel(evidence, { baselineSource = null, seasonStarted = null } = {}) {
  if (baselineSource === 'baseline') return 'Last season';
  if (evidence && evidence.kind === 'previous-season') return 'Last season';
  if (evidence && evidence.kind === 'none') return 'Season totals (not published yet)';
  if (evidence && evidence.kind === 'partial-season') return 'This season so far';
  if (seasonStarted === false) return 'Last season';
  return 'This season so far';
}

// A signed percentage, always with its sign, because the sign IS the direction
// and "84%" alone does not say which way the player is travelling.
//
// WHOLE NUMBERS EXCEPT NEAR THE THRESHOLD. Rounding to no decimals is right for
// almost every value, but it can move a number ACROSS the crossing point and
// make the drawer contradict its own badge: Thiago sat at -99.8% on 2026-09-06,
// which rounded to "-100%" and read as a change tonight while the chip
// correctly said tomorrow, because -99.8 does not cross. So when rounding would
// put a value on the other side of the threshold from where it really is, one
// decimal is shown instead. Everything else stays a whole number.
function signedPercent(v) {
  if (!Number.isFinite(v)) return '-';
  const rounded = Math.round(v);
  const crossesReally = Math.abs(v) >= PRICE_CHANGE_THRESHOLD;
  const crossesRounded = Math.abs(rounded) >= PRICE_CHANGE_THRESHOLD;
  const digits = crossesReally === crossesRounded ? 0 : 1;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

// Fantasy Premier League's own price prediction, laid out as the three windows
// it actually publishes and no further.
//
// Returns null when the payload carries nothing, which is the case for every
// pre-2026/27 fixture and for any future season where FPL withdraws the fields.
// The drawer then looks exactly as it did before this feature existed.
function priceChangeSection(player, gameState, now) {
  if (!player || !player.priceChange) return null;

  const deadlines = (gameState.rules && gameState.rules.priceChangeDeadlines) || [];
  const windows = upcomingDeadlines(deadlines, now);
  const model = readPriceChange(player, { now, deadlines });
  const pc = player.priceChange;

  const rows = pc.projections.map((p) => {
    const when = windows[p.offset];
    // The VISIBLE label is the relative word, because the row's label column is
    // sized for "GW 13" and a localised "Sun, 6 Sep, 05:02 PM" wrapped it onto
    // four lines. The exact official moment is not lost: it is the row's
    // tooltip, so the precise time is a hover away and is never invented.
    const label = ['Tonight', 'Tomorrow', 'In 2 days'][p.offset] || `In ${p.offset} days`;
    // The tier is a WORD, never a percentage: `likelihood` is an ordinal
    // confidence rating and rendering it as "100% likely" would be the app
    // inventing a probability Fantasy Premier League never published.
    const tier = tierWordFor(p.likelihood, pc.calibrating);
    return el('div', {
      class: 'fpl-dw-gw',
      title: when ? `Fantasy Premier League applies this change at ${dateTime(when)}` : undefined,
    }, [
      el('span', { class: 'fpl-dw-gw-k', text: label }),
      el('span', {
        // The threshold constant, never a literal 100: this class is what
        // colours a row as an actual change, so it has to agree with the badge
        // exactly rather than by coincidence.
        class: `fpl-dw-gw-v ${Math.abs(p.projectedPercent) >= PRICE_CHANGE_THRESHOLD ? (p.projectedPercent > 0 ? 'is-rise' : 'is-fall') : ''}`.trim(),
        text: signedPercent(p.projectedPercent),
      }),
      el('span', { class: 'fpl-dw-gw-f', text: tier || '' }),
    ]);
  });

  const notes = [];
  if (model.locked) {
    notes.push(model.lockedUntil
      ? `Price locked until ${dateTime(model.lockedUntil)}. It cannot change before then, whatever the projection reads.`
      : 'Price locked. It cannot change yet, whatever the projection reads.');
  }
  if (pc.calibrating) {
    notes.push('Fantasy Premier League reports this prediction as still calibrating, so it is shown without a confidence rating.');
  }

  return el('section', { class: 'fpl-dw-section' }, [
    el('div', { class: 'fpl-subhead', text: 'Price change' }),
    el('div', { class: 'fpl-dw-stats' }, [
      statCell(
        'Current progress',
        signedPercent(pc.progressPercent),
        `Towards a change at ${PRICE_CHANGE_THRESHOLD}%`,
      ),
    ]),
    rows.length ? el('div', { class: 'fpl-dw-gws' }, rows) : null,
    ...notes.map(text => el('p', { class: 'fpl-dw-news', text })),
    el('p', {
      class: 'fpl-card-sub',
      text: 'Predicted by Fantasy Premier League and read straight from its data. It reaches three days ahead and no further.',
    }),
  ]);
}

// |likelihood| -> the word shown. Kept alongside the section that renders it
// rather than exported from the engine, because the ENGINE'S tiers drive a
// decision and this is only ever prose.
function tierWordFor(likelihood, calibrating) {
  if (calibrating) return 'Calibrating';
  if (!Number.isFinite(likelihood)) return null;
  const mag = Math.abs(likelihood);
  if (mag >= 5) return 'Strong signal';
  if (mag >= 3) return 'Moderate signal';
  if (mag >= 1) return 'Slight signal';
  return 'No signal';
}

function drawerContent({ playerId, gameState, projections, gw, horizon, evidence = null, now = Date.now() }) {
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
    el('div', {
      class: 'fpl-subhead',
      text: seasonTotalsLabel(evidence, {
        baselineSource: gameState.baselineSource,
        seasonStarted: gameState.seasonStarted,
      }),
    }),
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

  return [header, news, projection, minutes, priceChangeSection(player, gameState, now), season];
}

// The drawer's body, rendered into a detached node.
//
// Exported so the sections can be asserted under `node --test` without driving
// the modal's focus trap and scroll lock, which need a real browser. The open
// path below renders the same `drawerContent`, so a test here is a test of what
// ships rather than of a parallel description of it.
export function drawerBodyForTest(args) {
  return el('div', {}, drawerContent(args));
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
