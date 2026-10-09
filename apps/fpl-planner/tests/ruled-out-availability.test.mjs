// A ruled-out player over the horizon, a mid-season signing's denominator, a
// loanee's parent-club gameweeks and a double gameweek's appearance chance.
//
// Each test pins a defect found by the 2026-10-09 backend audit
// (apps/fpl-planner/.reports/fpl-planner-session-report-2026-10-09-1638.md):
//
//   B2  `i` and `s` returned zero minutes for EVERY gameweek of the horizon,
//       while the same 0% doubt encoded as `d` recovered by the measured 0.92.
//   B9  a January signing's start rate was divided by club matches played
//       before he arrived.
//   B10 `scout_risks` loan ineligibility was never read.
//   B6  a double gameweek treated the two fixtures' availability as
//       independent, so a 50% doubt read 0.69 to appear.
//
// The real-payload tests rebuild the 2026/27 gameweek 4 deadline exactly as the
// app does (tests/fixtures/xp-calibration-2026, engine/world.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState, ineligibleGameweeks } from '../js/engine/normalize.js';
import { openingBaselineApplies, resolveGameState } from '../js/engine/world.js';
import { buildStrength } from '../js/engine/strength.js';
import { projectPlayerGw } from '../js/engine/projections.js';
import { projectMinutes, newsReturnDate, ruledOutAvailability, MINUTES_PARAMS } from '../js/engine/minutes.js';
import { deadlinePayload } from './helpers/xp-calibration-fixture.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = JSON.parse(readFileSync(join(APP, 'data', 'opening-baseline.json'), 'utf8'));

let gw4 = null;
function world() {
  if (gw4) return gw4;
  const { bootstrap, fixtures, fetchedAt } = deadlinePayload(4);
  const first = buildGameState(bootstrap, fixtures, { fetchedAt });
  const { gameState } = resolveGameState(first, {
    bootstrap, fixtures, fetchedAt, kept: null, shipped: openingBaselineApplies(first) ? SHIPPED : null,
  });
  const strength = buildStrength(gameState, { asOfGw: 4 });
  gw4 = { gameState, strength };
  return gw4;
}

// The fittest high-xP regular in the payload, so the test does not hang on a name.
function star() {
  const { gameState, strength } = world();
  let best = null;
  for (const p of gameState.players.values()) {
    if (p.status !== 'a' || p.position !== 3) continue;
    const r = projectPlayerGw(p, { gameState, strength, gw: 4 });
    if (!best || r.xPoints > best.xP) best = { p, xP: r.xPoints };
  }
  return best.p;
}

// The club's fixture kickoffs per gameweek, so a news date can be written
// relative to the real calendar.
function kickoffsOf(gameState, teamId, gw) {
  return gameState.fixtures
    .filter(f => f.event === gw && (f.teamH === teamId || f.teamA === teamId))
    .map(f => Date.parse(f.kickoff));
}

const dayMonth = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
};

function horizon(player, from = 4, to = 8) {
  const { gameState, strength } = world();
  const out = [];
  for (let gw = from; gw <= to; gw++) out.push(projectPlayerGw(player, { gameState, strength, gw }).xPoints);
  return out;
}

test('the news date parser reads FPL\'s two phrasings and picks the year after the note', () => {
  assert.equal(newsReturnDate('Suspended until 19 Oct', '2026-09-13T15:00:09Z'), Date.UTC(2026, 9, 19));
  assert.equal(newsReturnDate('Hamstring injury - Expected back 10 Oct', '2026-09-20T10:00:00Z'), Date.UTC(2026, 9, 10));
  assert.equal(newsReturnDate('Knee injury - Expected back 3 Jan', '2026-12-20T10:00:00Z'), Date.UTC(2027, 0, 3));
  assert.equal(newsReturnDate('Knee injury - Unknown return date', '2026-09-20T10:00:00Z'), null);
  assert.equal(newsReturnDate('Ankle injury - 75% chance of playing', '2026-09-20T10:00:00Z'), null);
  assert.equal(newsReturnDate('', null), null);
});

test('B2: a suspended premium is zero only until the date FPL gives, then fully back', () => {
  const p = star();
  const { gameState } = world();
  const fit = horizon(p);
  // Back from the first fixture of gameweek 6: "until <that day>".
  const back = Math.min(...kickoffsOf(gameState, p.teamId, 6));
  const banned = { ...p, status: 's', chanceNext: 0, news: `Suspended until ${dayMonth(back)}`, newsAdded: '2026-09-12T10:00:00Z' };
  const xp = horizon(banned);
  assert.equal(xp[0], 0, 'GW4: banned');
  assert.equal(xp[1], 0, 'GW5: still banned (every GW5 fixture is before the date)');
  for (let k = 2; k < 5; k++) {
    assert.ok(Math.abs(xp[k] - fit[k]) < 1e-9, `GW${4 + k}: back in full (${xp[k]} vs ${fit[k]})`);
  }
});

test('B2: an injury with an expected return is a doubt in the return week, recovering after it', () => {
  const p = star();
  const { gameState } = world();
  const back = Math.min(...kickoffsOf(gameState, p.teamId, 6));
  const hurt = { ...p, status: 'i', chanceNext: 0, news: `Hamstring injury - Expected back ${dayMonth(back)}`, newsAdded: '2026-09-12T10:00:00Z' };
  for (const [gw, expected] of [[4, 0], [5, 0], [6, 0.75], [7, 1 - 0.25 * MINUTES_PARAMS.horizonDoubtDecay]]) {
    const r = ruledOutAvailability(hurt, { gameState, gw });
    assert.ok(Math.abs(r.availability - expected) < 1e-9, `GW${gw}: ${r.availability} vs ${expected} (${r.reason})`);
  }
  const xp = horizon(hurt);
  const fit = horizon(p);
  assert.equal(xp[0], 0);
  assert.ok(xp[2] > 0 && xp[2] < fit[2], 'the return week is discounted, not certain');
  assert.ok(xp[4] > xp[2] * (fit[4] / fit[2]) - 1e-9, 'and recovers after it');
});

test('B2: an unknown return date recovers exactly like a 0% doubt, never as a five-week absence', () => {
  const p = star();
  const { gameState } = world();
  const unknown = { ...p, status: 'i', chanceNext: 0, news: 'Knee injury - Unknown return date', newsAdded: '2026-09-12T10:00:00Z' };
  const doubt = { ...p, status: 'd', chanceNext: 0, news: '', newsAdded: null };
  const a = horizon(unknown);
  const b = horizon(doubt);
  for (let k = 0; k < 5; k++) assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `gw+${k}: ${a[k]} vs ${b[k]}`);
  assert.equal(a[0], 0);
  assert.ok(a[4] > 0, 'four gameweeks out he is not projected as certain to miss');
  // The gameweek being decided is never relaxed, whatever the news says.
  assert.equal(projectMinutes(unknown, { gameState, gw: gameState.nextEvent }).pAppear, 0);
});

test('B2: a return date that has already passed while the flag is still up is read as no date', () => {
  const p = star();
  const { gameState } = world();
  const slipped = { ...p, status: 'i', chanceNext: 0, news: 'Groin injury - Expected back 22 Aug', newsAdded: '2026-07-25T14:30:10Z' };
  const unknown = { ...p, status: 'i', chanceNext: 0, news: 'Groin injury - Unknown return date', newsAdded: '2026-07-25T14:30:10Z' };
  for (let gw = 4; gw <= 8; gw++) {
    assert.deepEqual(ruledOutAvailability(slipped, { gameState, gw }).availability, ruledOutAvailability(unknown, { gameState, gw }).availability, `GW${gw}`);
  }
});

test('B2: left the club (u) and not eligible (n) stay zero across the horizon', () => {
  const p = star();
  for (const status of ['u', 'n']) {
    const gone = { ...p, status, chanceNext: 0, news: 'Has joined Getafe permanently', newsAdded: '2026-09-01T10:00:00Z' };
    assert.deepEqual(horizon(gone), [0, 0, 0, 0, 0], status);
  }
});

test('B10: a loanee is projected at zero in exactly the gameweeks FPL lists, and normally otherwise', () => {
  assert.deepEqual(ineligibleGameweeks([
    { property: 'loan_ineligible', gameweek: 8, notes: '...' },
    { property: 'loan_ineligible', gameweek: 35 },
    { property: 'something_else', gameweek: 6 },
    null,
  ]), [8, 35]);
  assert.deepEqual(ineligibleGameweeks(undefined), []);

  const p = star();
  const fit = horizon(p);
  const loanee = { ...p, ineligibleGws: [6] };
  const xp = horizon(loanee);
  assert.equal(xp[2], 0, 'GW6 against the parent club');
  for (const k of [0, 1, 3, 4]) assert.ok(Math.abs(xp[k] - fit[k]) < 1e-9, `gw+${k}`);
});

test('B9: a mid-season signing is read over his new club\'s matches since he joined', () => {
  const { gameState } = world();
  const p = star();
  // His club's matches kicked off before gameweek 4: three. Pretend he joined
  // just before the third and has started it.
  const kicks = gameState.fixtures
    .filter(f => (f.teamH === p.teamId || f.teamA === p.teamId) && f.event <= 3)
    .map(f => Date.parse(f.kickoff))
    .sort((a, b) => a - b);
  assert.equal(kicks.length, 3);
  const joined = new Date(kicks[2] - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const signing = {
    ...p, prior: null, starts: 1, minutes: 90, seasonStarts: 1, seasonMinutes: 90, teamJoinDate: joined,
  };
  const wholeSeason = { ...signing, teamJoinDate: null };
  const a = projectMinutes(signing, { gameState, gw: 4 });
  const b = projectMinutes(wholeSeason, { gameState, gw: 4 });
  assert.ok(a.pStart > b.pStart + 0.1, `one start from one eligible match (${a.pStart}) beats one from three (${b.pStart})`);

  // More minutes than his matches since joining could hold: he played them for
  // another Premier League club, so the whole season stays his denominator.
  const mover = { ...signing, starts: 3, minutes: 270, seasonStarts: 3, seasonMinutes: 270 };
  const moverWhole = { ...mover, teamJoinDate: null };
  assert.equal(projectMinutes(mover, { gameState, gw: 4 }).pStart, projectMinutes(moverWhole, { gameState, gw: 4 }).pStart);

  // A summer signing (joined before the club's first match) is untouched.
  const summer = { ...signing, teamJoinDate: '2026-07-01' };
  assert.equal(projectMinutes(summer, { gameState, gw: 4 }).pStart, b.pStart);
  // And a join date after the deadline being planned is ignored (a replayed
  // payload carrying the archive's final date).
  const future = { ...signing, teamJoinDate: '2027-01-15' };
  assert.equal(projectMinutes(future, { gameState, gw: 4 }).pStart, b.pStart);
});

test('B6: a double gameweek shares one availability between its two fixtures', () => {
  const { gameState, strength } = world();
  const p = star();
  const f0 = gameState.fixtures.find(f => f.event === 4 && (f.teamH === p.teamId || f.teamA === p.teamId));
  const doubled = { ...gameState, fixtures: [...gameState.fixtures, { ...f0, id: 999999 }] };
  const doubt = { ...p, status: 'd', chanceNext: 0.5 };

  const single = projectPlayerGw(doubt, { gameState, strength, gw: 4 });
  const dgw = projectPlayerGw(doubt, { gameState: doubled, strength, gw: 4 });
  assert.ok(single.pAppear <= 0.5 + 1e-12);
  assert.ok(dgw.pAppear <= 0.5 + 1e-12, `a 50% doubt can never be likelier than 50% to appear (${dgw.pAppear})`);
  assert.ok(dgw.pAppear >= single.pAppear - 1e-12, 'two fixtures are at least as many chances as one');

  // A fit player keeps the independent read: two chances to be picked.
  const fitSingle = projectPlayerGw(p, { gameState, strength, gw: 4 });
  const fitDouble = projectPlayerGw(p, { gameState: doubled, strength, gw: 4 });
  const m = projectMinutes(p, { gameState: doubled, gw: 4 });
  assert.ok(Math.abs(fitDouble.pAppear - (1 - (1 - m.pAppear) ** 2)) < 1e-12);
  assert.ok(fitDouble.pAppear >= fitSingle.pAppear - 1e-12);

  // A blank is zero.
  const blank = { ...gameState, fixtures: gameState.fixtures.filter(f => !(f.event === 4 && (f.teamH === p.teamId || f.teamA === p.teamId))) };
  assert.equal(projectPlayerGw(p, { gameState: blank, strength, gw: 4 }).pAppear, 0);
});
