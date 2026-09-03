// "Make these transfers on Fantasy Premier League": the button on the transfers
// card, and the dialog behind it.
//
// SHAPE, AND WHY IT CHANGED (2026-09-02): this shipped as a collapsed
// <details> at the foot of the card, which put the only action the app offers
// behind the same chrome as its context panels, where it read as more reading
// rather than as a thing to press. It is a primary button now, labelled with
// the act ("Make these 2 transfers on FPL"), and the steps live in a dialog
// that opens when it is pressed.
//
// The dialog copies the plan the instant it opens, inside the click that
// opened it, because a clipboard write is only permitted while a user gesture
// is being handled. Everything after that is one hop the browser cannot remove:
// only code running on fantasy.premierleague.com can spend an FPL session, so
// the user goes there and clicks the bookmarklet. What CAN be removed is
// repeating the install ritual, so it is remembered.

import { el, clear } from './dom.js';
import { btn } from './parts.js';
import { plural } from './format.js';
import { buildHandoff, encodeHandoff, SELECTION_CHIPS } from './handoff.js';
import { BOOKMARKLET_URL } from './bookmarklet-url.js';
import { lockScroll, unlockScroll } from './scroll-lock.js';

const FPL_TRANSFERS_URL = 'https://fantasy.premierleague.com/transfers';

// The bookmarklet's own name, as it will read in a bookmarks bar. Short on
// purpose: a bookmarks bar is the most crowded strip in a browser.
export const BOOKMARKLET_NAME = 'FPL Transfer';

function defaultCopyText(text) {
  if (!globalThis.navigator || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
    return Promise.reject(new Error('no clipboard'));
  }
  return navigator.clipboard.writeText(text);
}

// The button says what pressing it does, with the count already in it, so the
// action is legible without reading the card above it.
export function transferActionLabel(plan) {
  const n = (plan && plan.transferCount) || 0;
  return n === 1
    ? 'Make this transfer on FPL'
    : `Make these ${n} ${plural(n, 'transfer')} on FPL`;
}

// The row that lives in the transfers card. Returns null wherever there is
// nothing to hand over, so the card is untouched for a roll, the pre-season
// draft, a missing team id, and the sample dataset (whose team id belongs to
// nobody, so pointing a bookmarklet at it could only fail).
export function handoffAction({ plan, teamId, sample = false, onOpen }) {
  if (sample || !plan) return null;
  if (!buildHandoff({ plan, teamId }).ok) return null;

  const button = btn(transferActionLabel(plan), (event) => {
    if (typeof onOpen === 'function') onOpen({ trigger: event && event.target });
  }, { variant: 'fpl-btn-primary' });

  return el('div', { class: 'fpl-handoff-action' }, [
    button,
    el('span', { class: 'fpl-handoff-action-note', text: 'Opens the steps. Nothing is sent until you confirm on Fantasy Premier League.' }),
  ]);
}

/* -------------------------------------------------------------- the dialog */

function statusLine() {
  return el('div', { class: 'fpl-handoff-status', role: 'status', 'aria-live': 'polite' });
}

function setStatus(node, tone, text) {
  node.className = `fpl-handoff-status is-${tone}`;
  node.textContent = text;
}

function block(title, children, { className = '' } = {}) {
  return el('div', { class: `fpl-handoff-block ${className}`.trim() }, [
    el('div', { class: 'fpl-handoff-block-t', text: title }),
    ...children,
  ]);
}

// The dialog's CONTENT, built as a pure function of the plan and what the user
// has already installed, so every branch below is reachable under the repo's
// mini DOM. The overlay machinery around it (backdrop, Escape, focus trap,
// scroll lock) follows createPlayerDrawer and, like the drawer's, is exercised
// in the browser suite and the human plan rather than here: none of it is
// meaningful without layout, focus and real key events.
export function handoffDialogContent({
  plan,
  teamId,
  installed = false,
  showInstall = false,
  copyText = defaultCopyText,
  onInstalled = () => {},
  onShowInstall = () => {},
}) {
  const built = buildHandoff({ plan, teamId });
  if (!built.ok) {
    return {
      ok: false,
      reason: built.reason,
      planText: null,
      copyStatus: null,
      nodes: [
        el('h3', { class: 'fpl-handoff-h', text: 'Nothing to hand over' }),
        el('p', { class: 'fpl-handoff-note', text: built.reason }),
      ],
    };
  }

  const planText = encodeHandoff(built.payload);
  const copyStatus = statusLine();
  const wantsInstall = !installed || showInstall;

  const markInstalled = () => { onInstalled(); };

  // The install step, shown when the user has never installed the bookmarklet
  // and whenever they ask to see it again. Dragging the link or copying it is
  // taken as having installed it: both are real signals from the DOM, and
  // being wrong only costs one extra visible step next time.
  const installNodes = [];
  if (wantsInstall) {
    const hint = statusLine();
    const link = el('a', {
      class: 'fpl-handoff-drag',
      href: BOOKMARKLET_URL,
      title: `Drag me to your bookmarks bar, then click me on ${FPL_TRANSFERS_URL}`,
      ondragstart: markInstalled,
      onclick: (event) => {
        event.preventDefault();
        setStatus(hint, 'bad', 'This one is for dragging, not clicking. Drag it to your bookmarks bar, or use the copy button beside it.');
      },
    }, BOOKMARKLET_NAME);

    const copyLink = btn('Copy the link instead', async () => {
      try {
        await copyText(BOOKMARKLET_URL);
        setStatus(hint, 'ok', 'Copied. Make a new bookmark and paste this as its address.');
        markInstalled();
      } catch (err) {
        setStatus(hint, 'bad', 'Your browser would not let the page copy. Right-click the link and copy its address.');
      }
    }, { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' });

    installNodes.push(block('First, install it (once)', [
      el('p', { class: 'fpl-handoff-note', text: 'Drag this to your bookmarks bar. It is a bookmark, not an extension, and it only runs when you click it.' }),
      el('div', { class: 'fpl-handoff-drag-row' }, [link, copyLink]),
      hint,
    ], { className: 'is-install' }));
  }

  const goBlock = block(wantsInstall ? 'Then apply it' : 'Apply it', [
    el('p', { class: 'fpl-handoff-note' }, [
      `Open Fantasy Premier League, click ${BOOKMARKLET_NAME} in your bookmarks bar, and check the panel it opens. It lists every move with `,
      el('b', { text: "Fantasy Premier League's own prices" }),
      ' and submits nothing until you confirm.',
    ]),
    el('div', { class: 'fpl-handoff-drag-row' }, [
      el('a', {
        class: 'fpl-handoff-go',
        href: FPL_TRANSFERS_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'Open my FPL transfers page',
      }),
      btn('Copy the plan again', async () => {
        try {
          await copyText(planText);
          setStatus(copyStatus, 'ok', 'Copied again.');
        } catch (err) {
          setStatus(copyStatus, 'bad', 'Your browser would not let the page copy. Select the text below and copy it yourself.');
        }
      }, { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' }),
    ]),
    el('code', { class: 'fpl-handoff-payload', text: planText }),
    el('p', { class: 'fpl-handoff-note', text: 'Player ids and a gameweek, and nothing else. Prices, your bank and your free transfers are read from Fantasy Premier League when you submit, so they are never out of date.' }),
  ]);

  const nodes = [
    el('h3', { class: 'fpl-handoff-h', text: transferActionLabel(plan) }),
    el('p', { class: 'fpl-handoff-lead', text: 'This planner cannot sign in to Fantasy Premier League and never asks for your password. The bookmarklet runs in your own browser, on their site, using the session you already have there.' }),
    copyStatus,
    ...installNodes,
    goBlock,
  ];

  if (built.deferredChip && SELECTION_CHIPS.includes(built.deferredChip)) {
    nodes.push(el('p', { class: 'fpl-handoff-warn', text: 'The chip this plan recommends is played on your Fantasy Premier League team page, not by transferring. The bookmarklet makes the transfers; switching the chip on is still yours to do.' }));
  }

  if (!wantsInstall) {
    nodes.push(btn('Show the install step again', onShowInstall, { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' }));
  }

  nodes.push(el('p', { class: 'fpl-handoff-note fpl-handoff-fine', text: 'Fantasy Premier League publishes no supported way to make a transfer from outside their site, so this uses the same request their own pages make and can stop working without warning. It tells you when it does rather than guessing.' }));

  return { ok: true, reason: null, nodes, planText, copyStatus };
}

// One dialog per app, built the way the player drawer is: mounted on the app
// ROOT WRAPPER so app CSS reaches it without z-index games against shared
// chrome, page scroll locked through scroll-lock.js, Escape and the backdrop
// both close, focus trapped while open and returned to the opener after.
export function createHandoffDialog({ root, context, copyText = defaultCopyText }) {
  let node = null;
  let lastFocus = null;
  let showInstall = false;

  function close() {
    if (!node) return;
    node.remove();
    node = null;
    unlockScroll();
    document.removeEventListener('keydown', onKeydown, true);
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
      const focusable = node.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  function render(ctx) {
    clear(node);
    const closeBtn = el('button', {
      type: 'button',
      class: 'fpl-dw-close',
      'aria-label': 'Close',
      onclick: close,
    }, el('i', { class: 'fa-solid fa-xmark', 'aria-hidden': 'true' }));

    const content = handoffDialogContent({
      plan: ctx.plan,
      teamId: ctx.teamId,
      installed: ctx.installed === true,
      showInstall,
      copyText,
      onInstalled: () => {
        showInstall = false;
        if (typeof ctx.onInstalled === 'function') ctx.onInstalled();
      },
      onShowInstall: () => { showInstall = true; render(context()); },
    });

    const panel = el('div', {
      class: 'fpl-handoff-dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': content.ok ? transferActionLabel(ctx.plan) : 'Nothing to hand over',
    }, [closeBtn, ...content.nodes]);

    node.append(el('div', { class: 'fpl-handoff-backdrop', onclick: close }), panel);
    try { closeBtn.focus({ preventScroll: true }); } catch { closeBtn.focus(); }
    return content;
  }

  function open({ trigger = null } = {}) {
    const ctx = context();
    if (!ctx || !ctx.plan) return;
    lastFocus = trigger || document.activeElement;
    showInstall = false;
    if (!node) {
      node = el('div', { class: 'fpl-handoff-overlay' });
      root.appendChild(node);
      document.addEventListener('keydown', onKeydown, true);
      lockScroll();
    }
    const content = render(ctx);
    if (!content.ok) return;

    // The whole point of the button: by the time the dialog is readable, the
    // plan is already on the clipboard and the user only has to go and paste.
    // Started here rather than inside the content builder so that re-rendering
    // (asking for the install step again) does not copy a second time, and
    // still inside the click that opened the dialog on the first pass, which is
    // what makes a clipboard write permitted at all.
    setStatus(content.copyStatus, 'ok', 'Copying the plan...');
    copyText(content.planText).then(
      () => setStatus(content.copyStatus, 'ok', 'Plan copied to your clipboard.'),
      () => setStatus(content.copyStatus, 'bad', 'Your browser would not let the page copy. Copy the plan text below by hand.')
    );
  }

  return { open, close };
}
