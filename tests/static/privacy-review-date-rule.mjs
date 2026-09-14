// The date rule behind tests/static/privacy-review-date.test.mjs, as pure
// functions, so every case is pinned without git or a real clock.
//
// "Last reviewed" is a date-only claim on a published page. It is the UTC
// calendar day the change reaches master: GitHub stamps the squash merge and
// Netlify publishes it minutes later, both in UTC. Not the owner's local date
// and not the runner's zone, which is why nothing here parses a date with
// `new Date('14 September 2026')` (local midnight wherever it runs).
//
// The rule is about the day a change lands, never about waiting for one:
//   - a date past today's UTC day claims a review that has not happened;
//   - a policy text change carries the UTC day it ships;
//   - two policy changes on the same UTC day share that day's date.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** "14 September 2026" -> "2026-09-14", or null when it is not a real date. */
export function reviewDay(text) {
  const m = /^\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*$/.exec(String(text));
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/** "2026-09-14" -> "14 September 2026", the form privacy.html uses. */
export function formatReviewDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const name = MONTHS[m - 1];
  return `${d} ${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}

/** The UTC calendar day of an instant (epoch ms or a Date), as "YYYY-MM-DD". */
export const utcDay = (instant) => new Date(instant).toISOString().slice(0, 10);

/** null, or why `date` claims a review that has not happened by `now`. */
export function futureDateProblem(date, now) {
  const day = reviewDay(date);
  if (!day) return `unparseable review date: ${date}`;
  const today = utcDay(now);
  return day > today ? `"Last reviewed" reads ${date}, but it is still ${today} in UTC` : null;
}

/**
 * null, or why a policy text change carries the wrong review date.
 *   was      the review date on the commit the change is made on top of
 *   date     the review date the change carries
 *   shipsAt  when the change reaches master (epoch ms)
 */
export function changedPolicyDateProblem({ was, date, shipsAt }) {
  const before = reviewDay(was);
  const day = reviewDay(date);
  if (!before) return `unparseable review date: ${was}`;
  if (!day) return `unparseable review date: ${date}`;
  if (day < before) return `"Last reviewed" moved back from ${was} to ${date}`;
  const shipDay = utcDay(shipsAt);
  if (day !== shipDay) {
    return `the policy text changed and ships on ${shipDay} (UTC), but "Last reviewed" reads ${date}. `
      + `Set it to ${formatReviewDay(shipDay)}.`;
  }
  return null;
}
