// Display formatting. Pure functions, no DOM, no globals, so they are unit
// tested directly under `node --test`.
//
// Money crosses every module boundary as INTEGER TENTHS and is turned into a
// string exactly here, at the edge, by the engine's own formatter.

import { formatMoney } from '../engine/rules.js';

export { formatMoney };

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

// Points. One decimal is the honest precision of the projections; two would
// imply the model is sharper than it is.
export function xp(value) {
  if (!Number.isFinite(value)) return '-';
  return value.toFixed(1);
}

export function signedXp(value) {
  if (!Number.isFinite(value)) return '-';
  const magnitude = Math.abs(value).toFixed(1);
  // A value like -0.0498 is genuinely negative but rounds to 0.0, and printing
  // "-0.0 pts" reads as a rendering bug rather than as "no meaningful
  // difference". Anything that rounds to zero is shown as a plain 0.0, so the
  // sign only ever appears when there is a difference big enough to see.
  if (magnitude === '0.0') return '0.0';
  return `${value >= 0 ? '+' : '-'}${magnitude}`;
}

export function points(value) {
  if (!Number.isFinite(value)) return '-';
  return String(Math.round(value));
}

export function rank(value) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  return value.toLocaleString('en-GB');
}

export function percent(p) {
  if (!Number.isFinite(p)) return '-';
  return `${Math.round(p * 100)}%`;
}

// "3 hours ago", "just now", "in 2 days". Used for both "Last synced" and
// "Plan calculated", which is why it handles the future as well as the past.
export function relativeTime(iso, now = Date.now()) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const deltaSec = Math.round((now - t) / 1000);
  const future = deltaSec < 0;
  const s = Math.abs(deltaSec);

  let phrase;
  if (s < 45) phrase = future ? 'in a moment' : 'just now';
  else if (s < 90) phrase = 'a minute';
  else if (s < HOUR) phrase = `${Math.round(s / MIN)} minutes`;
  else if (s < 2 * HOUR) phrase = 'an hour';
  else if (s < DAY) phrase = `${Math.round(s / HOUR)} hours`;
  else if (s < 2 * DAY) phrase = 'a day';
  else phrase = `${Math.round(s / DAY)} days`;

  if (s < 45) return phrase;
  return future ? `in ${phrase}` : `${phrase} ago`;
}

// Deadline countdown. Returns the parts as well as the text so the caller can
// mark the last few hours urgent without re-parsing a string.
export function countdown(iso, now = Date.now()) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return { text: 'unknown', passed: false, urgent: false, totalSeconds: null };
  const total = Math.floor((t - now) / 1000);
  if (total <= 0) return { text: 'Deadline passed', passed: true, urgent: false, totalSeconds: total };

  const d = Math.floor(total / DAY);
  const h = Math.floor((total % DAY) / HOUR);
  const m = Math.floor((total % HOUR) / MIN);
  const s = total % MIN;

  let text;
  if (d > 0) text = `${d}d ${h}h`;
  else if (h > 0) text = `${h}h ${m}m`;
  else text = `${m}m ${s}s`;

  return { text, passed: false, urgent: total < 6 * HOUR, totalSeconds: total };
}

// "Sat 22 Nov, 18:30" in the browser's own zone, because a deadline the user
// reads at the wrong hour is worse than no deadline at all.
export function dateTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  return new Date(t).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function shortDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const CHIP_LABELS = {
  wildcard: 'Wildcard',
  freehit: 'Free Hit',
  bboost: 'Bench Boost',
  '3xc': 'Triple Captain',
};

export function chipLabel(name) {
  if (!name) return null;
  return CHIP_LABELS[name] || name;
}

// The plural rule this app needs is only ever "transfer(s)"/"hit(s)"/"point(s)".
export function plural(n, one, many) {
  return n === 1 ? one : (many || `${one}s`);
}
