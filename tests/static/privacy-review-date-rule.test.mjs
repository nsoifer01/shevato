// The privacy review-date rule, pinned case by case (2026-09-14).
//
// The guard used to demand a review date strictly LATER than the base
// commit's. That refused an honest same-day follow-up: PR #533 published a
// policy edit dated 13 September, corrections found later that day could only
// ship under a later date, and they sat as "blocked until 14 September". A
// session then read "the 14th" as the owner's local midnight and proposed
// holding a green PR for hours when it was already the 14th in UTC. The rule is
// now stated in UTC and about the day a change ships, so there is no date to
// wait for: whatever the UTC day is when a change lands, that is its date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  changedPolicyDateProblem, formatReviewDay, futureDateProblem, reviewDay, utcDay,
} from './privacy-review-date-rule.mjs';

const at = (iso) => Date.parse(iso);

test('review dates are calendar days, not local midnights', () => {
  assert.equal(reviewDay('14 September 2026'), '2026-09-14');
  assert.equal(reviewDay('7 August 2026'), '2026-08-07');
  assert.equal(reviewDay('31 February 2026'), null, 'not a real date');
  assert.equal(reviewDay('14 Septembre 2026'), null, 'not an English month');
  assert.equal(formatReviewDay('2026-09-14'), '14 September 2026');
  assert.equal(utcDay(at('2026-09-13T21:20:00-05:00')), '2026-09-14', '21:20 in Chicago is already the 14th in UTC');
});

test('a date is in the future only once it passes the UTC day', () => {
  assert.equal(futureDateProblem('14 September 2026', at('2026-09-14T02:20:00Z')), null);
  assert.equal(futureDateProblem('14 September 2026', at('2026-09-14T00:00:00Z')), null);
  assert.match(futureDateProblem('14 September 2026', at('2026-09-13T23:59:59Z')), /still 2026-09-13 in UTC/);
});

test('the case that stalled: base dated 13 September, the change shipping at 02:20 UTC on the 14th', () => {
  const shipsAt = at('2026-09-14T02:20:00Z');
  assert.equal(changedPolicyDateProblem({ was: '13 September 2026', date: '14 September 2026', shipsAt }), null);
  assert.match(
    changedPolicyDateProblem({ was: '13 September 2026', date: '13 September 2026', shipsAt }),
    /ships on 2026-09-14 \(UTC\).*Set it to 14 September 2026\./,
  );
});

test('a second policy change on the same UTC day keeps that day\'s date', () => {
  assert.equal(
    changedPolicyDateProblem({ was: '13 September 2026', date: '13 September 2026', shipsAt: at('2026-09-13T20:00:00Z') }),
    null,
  );
});

test('PR #530: dated the day it was written, shipped the day after', () => {
  assert.match(
    changedPolicyDateProblem({ was: '7 September 2026', date: '11 September 2026', shipsAt: at('2026-09-12T15:00:00Z') }),
    /Set it to 12 September 2026\./,
  );
});

test('changed text under an old date is refused, and so is a date moved backwards', () => {
  assert.match(
    changedPolicyDateProblem({ was: '7 September 2026', date: '7 September 2026', shipsAt: at('2026-09-12T15:00:00Z') }),
    /Set it to 12 September 2026\./,
  );
  assert.match(
    changedPolicyDateProblem({ was: '13 September 2026', date: '12 September 2026', shipsAt: at('2026-09-12T15:00:00Z') }),
    /moved back/,
  );
});

test('the verdicts are the same in every runner timezone', () => {
  const script = `
    const r = await import(${JSON.stringify(new URL('./privacy-review-date-rule.mjs', import.meta.url).href)});
    const at = (iso) => Date.parse(iso);
    console.log(JSON.stringify([
      r.reviewDay('14 September 2026'),
      r.futureDateProblem('14 September 2026', at('2026-09-14T02:20:00Z')),
      r.futureDateProblem('14 September 2026', at('2026-09-13T23:59:59Z')),
      r.changedPolicyDateProblem({ was: '13 September 2026', date: '13 September 2026', shipsAt: at('2026-09-14T02:20:00Z') }),
      r.changedPolicyDateProblem({ was: '13 September 2026', date: '14 September 2026', shipsAt: at('2026-09-14T02:20:00Z') }),
    ]));`;
  const run = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, TZ: tz },
  }).trim();
  const zones = ['UTC', 'America/Chicago', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
  const results = zones.map(run);
  for (let i = 1; i < zones.length; i++) assert.equal(results[i], results[0], `${zones[i]} disagrees with UTC`);
  assert.equal(JSON.parse(results[0])[0], '2026-09-14');
});
