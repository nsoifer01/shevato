// "Make these transfers on Fantasy Premier League": the install-and-paste block
// that sits at the foot of the transfers card.
//
// It renders three steps and nothing else. The decision was made above it; this
// is only the route from a recommendation to the same transfers actually
// existing on FPL, and it is deliberately a route the user walks: the payload
// is visible, the bookmarklet asks before it submits, and the planner never
// holds an FPL credential (see js/ui/handoff.js for why that line is drawn
// there rather than in a server).
//
// Kept out of dashboard.js because none of it is a figure from the PlanBundle,
// which is what every other line of that file is.

import { el, disclosure } from './dom.js';
import { btn } from './parts.js';
import { buildHandoff, encodeHandoff, SELECTION_CHIPS } from './handoff.js';
import { BOOKMARKLET_URL } from './bookmarklet-url.js';

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

function step(number, title, body) {
  return el('li', { class: 'fpl-handoff-step' }, [
    el('div', { class: 'fpl-handoff-step-n', text: String(number) }),
    el('div', { class: 'fpl-handoff-step-body' }, [
      el('div', { class: 'fpl-handoff-step-t', text: title }),
      ...body,
    ]),
  ]);
}

// A button that reports what happened in its own status line rather than in an
// alert. Copy can fail (no permission, no secure context, an older browser) and
// the failure has to be visible, because the next step silently does nothing
// without it.
function copyButton({ label, text, copyText, doneLabel }) {
  const status = el('span', { class: 'fpl-handoff-status', role: 'status', 'aria-live': 'polite' });
  const control = btn(label, async () => {
    try {
      await copyText(text);
      status.className = 'fpl-handoff-status is-ok';
      status.textContent = doneLabel;
    } catch (err) {
      status.className = 'fpl-handoff-status is-bad';
      status.textContent = 'Your browser would not let the page copy. Select the text below and copy it yourself.';
    }
  }, { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' });
  return { row: el('div', { class: 'fpl-handoff-actions' }, [control, status]), control, status };
}

// `plan` and `teamId` are all this needs; everything else about the squad is
// read from FPL by the bookmarklet, authenticated, at the moment it runs.
//
// Returns null rather than an empty shell whenever there is nothing to hand
// over, so the transfers card is unchanged in every state that had no handoff:
// a rolled transfer, the pre-season draft, and the sample dataset (whose team
// id belongs to nobody, so pointing a bookmarklet at it could only fail).
export function handoffSection({ plan, teamId, sample = false, copyText = defaultCopyText }) {
  if (sample || !plan) return null;

  const built = buildHandoff({ plan, teamId });
  if (!built.ok) return null;

  const planText = encodeHandoff(built.payload);

  // An <a> whose href is a javascript: URL is how a bookmarklet is installed:
  // the user drags it to the bookmarks bar. Clicking it here is not the point
  // and the site's CSP blocks javascript: navigation anyway, so the click is
  // answered with the instruction instead of a silent nothing.
  const dragHint = el('div', { class: 'fpl-handoff-status', role: 'status', 'aria-live': 'polite' });
  const dragLink = el('a', {
    class: 'fpl-handoff-drag',
    href: BOOKMARKLET_URL,
    title: `Drag me to your bookmarks bar, then click me on ${FPL_TRANSFERS_URL}`,
    onclick: (ev) => {
      ev.preventDefault();
      dragHint.className = 'fpl-handoff-status is-bad';
      dragHint.textContent = 'This one is for dragging, not clicking. Drag it to your bookmarks bar, then click it on the Fantasy Premier League site.';
    },
  }, BOOKMARKLET_NAME);

  const bookmarkletCopy = copyButton({
    label: 'Copy the link instead',
    text: BOOKMARKLET_URL,
    copyText,
    doneLabel: 'Copied. Make a new bookmark and paste this as its address.',
  });

  const planCopy = copyButton({
    label: 'Copy plan',
    text: planText,
    copyText,
    doneLabel: 'Copied. The bookmarklet will read it from your clipboard.',
  });

  const steps = el('ol', { class: 'fpl-handoff-steps' }, [
    step(1, 'Install it once', [
      el('div', { class: 'fpl-handoff-drag-row' }, [
        el('span', { class: 'fpl-handoff-drag-lead', text: 'Drag this to your bookmarks bar:' }),
        dragLink,
      ]),
      dragHint,
      bookmarkletCopy.row,
    ]),
    step(2, 'Copy this plan', [
      planCopy.row,
      el('code', { class: 'fpl-handoff-payload', text: planText }),
      el('p', { class: 'fpl-handoff-note', text: 'Player ids and a gameweek, and nothing else. Prices and your free transfers are read from Fantasy Premier League when you submit, so they are never out of date.' }),
    ]),
    step(3, 'Apply it on Fantasy Premier League', [
      el('p', { class: 'fpl-handoff-note' }, [
        'Open ',
        el('a', { class: 'fpl-handoff-link', href: FPL_TRANSFERS_URL, target: '_blank', rel: 'noopener noreferrer', text: 'your transfers page' }),
        `, click ${BOOKMARKLET_NAME} in your bookmarks bar, and check the panel it opens. It lists every move with Fantasy Premier League's own prices and submits nothing until you confirm.`,
      ]),
    ]),
  ]);

  const body = [
    el('p', { class: 'fpl-handoff-lead', text: 'This planner cannot sign in to Fantasy Premier League and never asks for your password. The bookmarklet below runs in your own browser, on their site, using the session you already have there.' }),
    steps,
  ];

  if (built.deferredChip && SELECTION_CHIPS.includes(built.deferredChip)) {
    body.push(el('p', { class: 'fpl-handoff-warn', text: 'The chip this plan recommends is played on your Fantasy Premier League team page, not by transferring. The bookmarklet makes the transfers; switching the chip on is still yours to do.' }));
  }

  body.push(el('p', { class: 'fpl-handoff-note fpl-handoff-fine', text: 'Fantasy Premier League publishes no supported way to make a transfer from outside their site, so this uses the same request their own pages make and can stop working without warning. It tells you when it does rather than guessing.' }));

  return disclosure('Make these transfers on Fantasy Premier League', body, { className: 'fpl-handoff' });
}
