import test from 'node:test';
import assert from 'node:assert/strict';

import {
  projectMinutes,
  positionPriors,
  calibration,
  p60FromMeanMinutes,
  availabilityCeiling,
  horizonSteps,
  MINUTES_PARAMS,
} from '../js/engine/minutes.js';
import { makeRng } from '../js/engine/ml.js';

// --- test world ------------------------------------------------------------

function makePlayer(over = {}) {
  return {
    id: 1,
    teamId: 1,
    position: 3,
    nowCost: 60,
    status: 'a',
    chanceNext: null,
    minutes: 0,
    starts: 0,
    ...over,
  };
}

function makeGameState(players, { fixtures = null, totalEvents = 38 } = {}) {
  const map = new Map();
  let id = 1;
  for (const p of players) map.set(id, { ...p, id: id++ });
  return {
    rules: { starters: 11, totalEvents },
    teams: new Map([[1, { id: 1 }], [2, { id: 2 }]]),
    players: map,
    fixtures: fixtures || [
      { id: 1, event: 1, teamH: 1, teamA: 2, finished: false },
      // Gameweek 2 is a blank for club 1 and a single for club 2.
      { id: 2, event: 2, teamH: 2, teamA: 2, finished: false },
      // Gameweek 3 is a double for club 1.
      { id: 3, event: 3, teamH: 1, teamA: 2, finished: false },
      { id: 4, event: 3, teamH: 2, teamA: 1, finished: false },
    ],
  };
}

// A believable league: nailed starters, rotation players, bench players and a
// tail of players who never featured, so the measured position priors are not
// degenerate.
function leaguePlayers() {
  const out = [];
  for (let t = 1; t <= 2; t++) {
    for (let pos = 1; pos <= 4; pos++) {
      out.push(makePlayer({ teamId: t, position: pos, minutes: 3200, starts: 36, nowCost: 90 }));
      out.push(makePlayer({ teamId: t, position: pos, minutes: 2400, starts: 27, nowCost: 70 }));
      out.push(makePlayer({ teamId: t, position: pos, minutes: 900, starts: 8, nowCost: 55 }));
      out.push(makePlayer({ teamId: t, position: pos, minutes: 240, starts: 1, nowCost: 45 }));
      out.push(makePlayer({ teamId: t, position: pos, minutes: 0, starts: 0, nowCost: 40 }));
    }
  }
  return out;
}

const LEAGUE = leaguePlayers();

test('position priors are measured from the league, not assumed', () => {
  const gs = makeGameState(LEAGUE);
  const { priors, teamMatches } = positionPriors(gs);
  assert.equal(teamMatches, 38, 'pre-season the denominator is a full season of gameweeks');
  const mid = priors.get(3);
  assert.ok(mid.startRate > 0.2 && mid.startRate < 0.7, `startRate ${mid.startRate}`);
  assert.ok(mid.starterMinutes > 60 && mid.starterMinutes <= 90, `starterMinutes ${mid.starterMinutes}`);
});

test('an unavailable status forces pAppear to zero', () => {
  const gs = makeGameState(LEAGUE);
  for (const status of ['i', 's', 'u', 'n']) {
    const p = makePlayer({ status, minutes: 3200, starts: 36 });
    const m = projectMinutes(p, { gameState: gs, gw: 1 });
    assert.equal(m.pAppear, 0, `status ${status}`);
    assert.equal(m.pStart, 0);
    assert.equal(m.xMins, 0);
    assert.equal(m.p60, 0);
    assert.equal(m.reason, `status-${status}`);
  }
});

test('a doubtful player with no percentage is halved, not zeroed', () => {
  const gs = makeGameState(LEAGUE);
  const fit = makePlayer({ minutes: 3200, starts: 36 });
  const doubt = makePlayer({ minutes: 3200, starts: 36, status: 'd' });
  const a = projectMinutes(fit, { gameState: gs, gw: 1 });
  const b = projectMinutes(doubt, { gameState: gs, gw: 1 });
  assert.equal(b.reason, 'doubtful-no-percentage');
  assert.ok(b.pStart > 0, 'doubtful is not out');
  assert.ok(
    Math.abs(b.pStart - a.pStart * MINUTES_PARAMS.doubtfulDefaultAvailability) < 1e-12,
    `${b.pStart} vs ${a.pStart}`,
  );
});

test('chance_of_playing_next_round overrides the historical rate and caps pAppear', () => {
  const gs = makeGameState(LEAGUE);
  const nailed = makePlayer({ minutes: 3400, starts: 38 });
  const full = projectMinutes(nailed, { gameState: gs, gw: 1 });
  assert.ok(full.pStart > 0.8, `a nailed starter should be above 0.8, got ${full.pStart}`);

  const quarter = projectMinutes({ ...nailed, status: 'd', chanceNext: 0.25 }, { gameState: gs, gw: 1 });
  assert.equal(quarter.reason, 'chance-of-playing');
  assert.ok(quarter.pAppear <= 0.25 + 1e-12, `pAppear ${quarter.pAppear} must not exceed the published chance`);
  assert.ok(quarter.pStart < full.pStart * 0.3);

  const zeroChance = projectMinutes({ ...nailed, status: 'd', chanceNext: 0 }, { gameState: gs, gw: 1 });
  assert.equal(zeroChance.pAppear, 0);
});

test('xMins follows the documented formula exactly', () => {
  const gs = makeGameState(LEAGUE);
  const p = makePlayer({ minutes: 2400, starts: 27 });
  const m = projectMinutes(p, { gameState: gs, gw: 1 });
  const expected = m.pStart * m.meanStarterMinutes + (m.pAppear - m.pStart) * m.meanSubMinutes;
  assert.ok(Math.abs(m.xMins - expected) < 1e-12);
  assert.ok(m.xMins > 0 && m.xMins < 90);
});

test('a player with no history gets a price-informed prior and low confidence', () => {
  const gs = makeGameState(LEAGUE);
  const cheap = makePlayer({ minutes: 0, starts: 0, nowCost: 40 });
  const pricey = makePlayer({ minutes: 0, starts: 0, nowCost: 90 });
  const a = projectMinutes(cheap, { gameState: gs, gw: 1 });
  const b = projectMinutes(pricey, { gameState: gs, gw: 1 });
  assert.equal(a.confidence, 'low');
  assert.equal(b.confidence, 'low');
  assert.equal(a.reason, 'no-history-prior');
  assert.ok(a.pStart > 0, 'zero history must not mean zero minutes');
  assert.ok(a.xMins > 0);
  assert.ok(b.pStart > a.pStart, 'the expensive signing should be likelier to start');
  assert.ok(b.pStart <= MINUTES_PARAMS.noHistoryMaxStart + 1e-12);
  assert.ok(a.pStart >= MINUTES_PARAMS.noHistoryMinStart - 1e-12);
});

// A season already under way: `played` finished matches for both clubs, then
// the gameweek being decided. A player with no minutes in this world has not
// merely failed to prove anything, he has been left out `played` times.
function seasonInProgress(played) {
  const fixtures = [];
  for (let i = 1; i <= played; i++) {
    fixtures.push({ id: i, event: i, teamH: 1, teamA: 2, finished: true });
  }
  fixtures.push({ id: played + 1, event: played + 1, teamH: 1, teamA: 2, finished: false });
  return { fixtures, gw: played + 1 };
}

test('the no-history price prior is untouched before a ball is kicked', () => {
  // Every pre-season payload and every gameweek 1 lands here, so this is the
  // guarantee that the decay cannot disturb the opening squad build.
  const gs = makeGameState(LEAGUE);
  const pricey = makePlayer({ minutes: 0, nowCost: 90 });
  const m = projectMinutes(pricey, { gameState: gs, gw: 1 });
  assert.equal(m.reason, 'no-history-prior');
  assert.ok(m.pStart > 0.6, `a marquee signing should still be a likely starter, got ${m.pStart}`);
});

test('the price prior decays by the matches his club played without him', () => {
  // Price is a pre-season signal. Once his club has played, "still on zero
  // minutes" is evidence the price cannot see, and the posterior is the Beta
  // mean for zero starts in m matches.
  const pricey = makePlayer({ minutes: 0, nowCost: 90 });
  const preSeason = projectMinutes(pricey, { gameState: makeGameState(LEAGUE), gw: 1 });
  const k = MINUTES_PARAMS.noHistoryPriorMatches;

  for (const played of [1, 3, 10, 25]) {
    const { fixtures, gw } = seasonInProgress(played);
    const m = projectMinutes(pricey, { gameState: makeGameState(LEAGUE, { fixtures }), gw });
    assert.equal(m.reason, 'no-history-unplayed');
    const expected = preSeason.pStart * (k / (played + k));
    assert.ok(
      Math.abs(m.pStart - expected) < 1e-12,
      `after ${played} matches pStart ${m.pStart} should be ${expected}`,
    );
  }
});

test('a player unplayed for ten gameweeks is a worse bet than the same player in August', () => {
  // The ordering is the whole point: before this decay existed the model priced
  // the two identically, off the same price percentile.
  const pricey = makePlayer({ minutes: 0, nowCost: 90 });
  const august = projectMinutes(pricey, { gameState: makeGameState(LEAGUE), gw: 1 });
  const { fixtures, gw } = seasonInProgress(10);
  const october = projectMinutes(pricey, { gameState: makeGameState(LEAGUE, { fixtures }), gw });

  assert.ok(october.pStart < august.pStart / 5, `${october.pStart} vs ${august.pStart}`);
  assert.ok(october.pAppear < august.pAppear / 5);
  assert.ok(october.xMins < august.xMins / 5);
  assert.ok(october.pStart > 0, 'never certain, only very unlikely');
});

test('the decay applies to coming off the bench, not only to starting', () => {
  // "Zero minutes after m matches" bears on appearing at all, so shrinking only
  // pStart would leave a player who never gets on the pitch with a bench
  // appearance rate of 0.22 forever.
  const pricey = makePlayer({ minutes: 0, nowCost: 90 });
  const preSeason = projectMinutes(pricey, { gameState: makeGameState(LEAGUE), gw: 1 });
  const k = MINUTES_PARAMS.noHistoryPriorMatches;
  const played = 6;
  const { fixtures, gw } = seasonInProgress(played);
  const m = projectMinutes(pricey, { gameState: makeGameState(LEAGUE, { fixtures }), gw });

  const w = k / (played + k);
  const expectedAppear = m.pStart + (1 - m.pStart) * (w * MINUTES_PARAMS.noHistorySubOnRate);
  assert.ok(Math.abs(m.pAppear - expectedAppear) < 1e-12, `${m.pAppear} vs ${expectedAppear}`);

  // The chance of getting on GIVEN he did not start, which is the quantity the
  // sub-on rate actually is, has decayed by the same weight.
  const subOn = (p) => (p.pAppear - p.pStart) / (1 - p.pStart);
  assert.ok(Math.abs(subOn(preSeason) - MINUTES_PARAMS.noHistorySubOnRate) < 1e-12);
  assert.ok(Math.abs(subOn(m) - w * MINUTES_PARAMS.noHistorySubOnRate) < 1e-12);
  assert.ok(m.pStart <= m.pAppear + 1e-12 && m.pAppear <= 1);
});

test('the decay reads the players own club, not the league', () => {
  // Club 1 has played five matches and club 2 has played none, which is what a
  // run of postponements looks like. The player at the idle club has had no
  // chance to be left out, so nothing about him has been learned yet.
  const fixtures = [];
  for (let i = 1; i <= 5; i++) fixtures.push({ id: i, event: i, teamH: 1, teamA: 3, finished: true });
  fixtures.push({ id: 90, event: 6, teamH: 1, teamA: 2, finished: false });
  const gs = makeGameState(LEAGUE, { fixtures });

  const atBusyClub = projectMinutes(makePlayer({ teamId: 1, minutes: 0, nowCost: 90 }), { gameState: gs, gw: 6 });
  const atIdleClub = projectMinutes(makePlayer({ teamId: 2, minutes: 0, nowCost: 90 }), { gameState: gs, gw: 6 });

  assert.equal(atIdleClub.reason, 'no-history-prior');
  assert.equal(atBusyClub.reason, 'no-history-unplayed');
  assert.ok(atBusyClub.pStart < atIdleClub.pStart / 4, `${atBusyClub.pStart} vs ${atIdleClub.pStart}`);
});

test('a blank gameweek yields zero minutes and a double lowers the per-fixture start chance', () => {
  const gs = makeGameState(LEAGUE);
  const p = makePlayer({ minutes: 3200, starts: 36 });
  const blank = projectMinutes(p, { gameState: gs, gw: 2 });
  assert.equal(blank.fixtureCount, 0);
  assert.equal(blank.xMins, 0);
  assert.equal(blank.reason, 'blank-gameweek');

  const single = projectMinutes(p, { gameState: gs, gw: 1 });
  const double = projectMinutes(p, { gameState: gs, gw: 3 });
  assert.equal(double.fixtureCount, 2);
  assert.ok(double.pStart < single.pStart, 'rotation risk rises in a double gameweek');
  assert.ok(
    Math.abs(double.pStart - single.pStart * MINUTES_PARAMS.congestionStartFactor) < 1e-12,
  );
});

test('confidence tracks how much history there is', () => {
  const gs = makeGameState(LEAGUE);
  const nailed = projectMinutes(makePlayer({ minutes: 3200, starts: 36 }), { gameState: gs, gw: 1 });
  const some = projectMinutes(makePlayer({ minutes: 500, starts: 5 }), { gameState: gs, gw: 1 });
  const barely = projectMinutes(makePlayer({ minutes: 120, starts: 1 }), { gameState: gs, gw: 1 });
  assert.equal(nailed.confidence, 'high');
  assert.equal(some.confidence, 'medium');
  assert.equal(barely.confidence, 'low');
});

test('p60 rises with typical starter minutes and is a probability', () => {
  assert.ok(Math.abs(p60FromMeanMinutes(60) - 0.5) < 1e-12);
  assert.ok(p60FromMeanMinutes(88) > 0.9);
  assert.ok(p60FromMeanMinutes(20) < 0.05);
  let prev = -1;
  for (let m = 0; m <= 90; m += 5) {
    const v = p60FromMeanMinutes(m);
    assert.ok(v >= prev, 'p60 must be non-decreasing in minutes');
    assert.ok(v >= 0 && v <= 1);
    prev = v;
  }
});

test('p60 never exceeds pAppear', () => {
  const gs = makeGameState(LEAGUE);
  for (const p of LEAGUE) {
    const m = projectMinutes(p, { gameState: gs, gw: 1 });
    assert.ok(m.p60 <= m.pAppear + 1e-12, `p60 ${m.p60} > pAppear ${m.pAppear}`);
  }
});

test('property: 0 <= pStart <= pAppear <= 1 over 2000 randomized inputs', () => {
  const rng = makeRng(20260810);
  const statuses = ['a', 'a', 'a', 'd', 'i', 's', 'u', 'n'];
  const gs = makeGameState(LEAGUE);

  for (let i = 0; i < 2000; i++) {
    const teamMatches = 38;
    const starts = Math.floor(rng() * (teamMatches + 1));
    // Minutes deliberately allowed to be inconsistent with starts, including
    // impossible combinations, because a live payload can be mid-update.
    const minutes = Math.floor(rng() * 3800);
    const player = makePlayer({
      position: 1 + Math.floor(rng() * 4),
      nowCost: 38 + Math.floor(rng() * 110),
      status: statuses[Math.floor(rng() * statuses.length)],
      chanceNext: rng() < 0.35 ? Math.round(rng() * 4) / 4 : null,
      minutes,
      starts,
    });
    const gw = 1 + Math.floor(rng() * 3);
    const m = projectMinutes(player, { gameState: gs, gw });

    assert.ok(Number.isFinite(m.pStart), 'pStart must be finite');
    assert.ok(Number.isFinite(m.pAppear), 'pAppear must be finite');
    assert.ok(Number.isFinite(m.xMins), 'xMins must be finite');
    assert.ok(m.pStart >= 0, `pStart ${m.pStart} < 0`);
    assert.ok(m.pStart <= m.pAppear + 1e-12, `pStart ${m.pStart} > pAppear ${m.pAppear}`);
    assert.ok(m.pAppear <= 1 + 1e-12, `pAppear ${m.pAppear} > 1`);
    assert.ok(m.p60 >= 0 && m.p60 <= m.pAppear + 1e-12);
    assert.ok(m.xMins >= 0 && m.xMins <= 90 + 1e-9, `xMins ${m.xMins}`);
    if (player.chanceNext !== null) {
      assert.ok(m.pAppear <= player.chanceNext + 1e-12, 'pAppear must respect the published chance');
    }
  }
});

// --- the three outcome decomposition ---------------------------------------

test('start, bench and no appearance are a partition, and xMins is their mixture', () => {
  const gs = makeGameState(LEAGUE);
  const rng = makeRng(4242);
  for (let i = 0; i < 500; i++) {
    const player = makePlayer({
      position: 1 + Math.floor(rng() * 4),
      nowCost: 38 + Math.floor(rng() * 110),
      status: rng() < 0.2 ? 'd' : 'a',
      chanceNext: rng() < 0.3 ? Math.round(rng() * 4) / 4 : null,
      minutes: Math.floor(rng() * 3800),
      starts: Math.floor(rng() * 39),
    });
    const m = projectMinutes(player, { gameState: gs, gw: 1 });

    assert.ok(Math.abs((m.pStart + m.pBench + m.pNone) - 1) < 1e-12, 'the three outcomes must sum to one');
    assert.ok(m.pBench >= 0, `pBench ${m.pBench}`);
    assert.ok(m.pNone >= 0, `pNone ${m.pNone}`);
    assert.ok(Math.abs(m.pAppear - (m.pStart + m.pBench)) < 1e-12, 'pAppear is start plus bench');
    // Expected minutes has to be the mixture of the conditional means, not a
    // separately maintained number that could drift from them.
    const mixture = m.pStart * m.xMinsIfStart + m.pBench * m.xMinsIfBench;
    assert.ok(Math.abs(m.xMins - mixture) < 1e-12, `${m.xMins} vs ${mixture}`);
    // Both conditional means stay physical even when the payload's minutes and
    // starts contradict each other, which a mid-update payload can do.
    assert.ok(m.xMinsIfStart > 0 && m.xMinsIfStart <= 90 + 1e-9, `xMinsIfStart ${m.xMinsIfStart}`);
    assert.ok(m.xMinsIfBench > 0 && m.xMinsIfBench <= 90 + 1e-9, `xMinsIfBench ${m.xMinsIfBench}`);
  }
});

test('for a coherent starter, a start is worth more minutes than a bench appearance', () => {
  const gs = makeGameState(LEAGUE);
  for (const [minutes, starts] of [[3200, 36], [2400, 27], [900, 10]]) {
    const m = projectMinutes(makePlayer({ minutes, starts }), { gameState: gs, gw: 1 });
    assert.ok(m.xMinsIfStart > m.xMinsIfBench, `${minutes}m over ${starts} starts`);
  }
});

test('an unavailable player is all of pNone and none of anything else', () => {
  const gs = makeGameState(LEAGUE);
  const m = projectMinutes(makePlayer({ status: 'i', minutes: 3200, starts: 36 }), { gameState: gs, gw: 1 });
  assert.equal(m.pNone, 1);
  assert.equal(m.pBench, 0);
  assert.equal(m.pStart, 0);
  assert.equal(m.xMins, 0);
});

// --- availability over a horizon -------------------------------------------

test('a doubt about a later gameweek is a smaller doubt, and never a larger one', () => {
  const decay = MINUTES_PARAMS.horizonDoubtDecay;
  const player = makePlayer({ status: 'd', chanceNext: 0.2, minutes: 3200, starts: 36 });

  const now = availabilityCeiling(player, { steps: 0 });
  assert.equal(now.availability, 0.2, 'the gameweek being decided is never relaxed');
  assert.equal(now.reason, 'chance-of-playing');

  let previous = now.availability;
  for (let steps = 1; steps <= 4; steps++) {
    const later = availabilityCeiling(player, { steps });
    assert.ok(Math.abs(later.availability - (1 - 0.8 * decay ** steps)) < 1e-12);
    assert.ok(later.availability > previous, 'doubt must shrink with distance, not grow');
    assert.ok(later.availability < 1, 'and it must never clear entirely');
    previous = later.availability;
  }
});

test('a fit player is unaffected by the horizon, at any distance', () => {
  const fit = makePlayer({ minutes: 3200, starts: 36 });
  for (const steps of [0, 1, 5, 20]) {
    assert.equal(availabilityCeiling(fit, { steps }).availability, 1);
  }
});

test('horizon distance is measured from the gameweek being decided', () => {
  const gs = makeGameState(LEAGUE);
  assert.equal(horizonSteps(gs, 3), 0, 'a state with no nextEvent cannot claim distance');

  const live = { ...gs, nextEvent: 5 };
  assert.equal(horizonSteps(live, 5), 0);
  assert.equal(horizonSteps(live, 7), 2);
  assert.equal(horizonSteps(live, 4), 0, 'the past is not negative distance');
});

test('the published chance is a hard ceiling on the gameweek it describes, and softens after', () => {
  const gs = makeGameState(LEAGUE);
  const live = { ...gs, nextEvent: 1 };
  const doubtful = makePlayer({ status: 'd', chanceNext: 0.25, minutes: 3200, starts: 36 });

  const thisGw = projectMinutes(doubtful, { gameState: live, gw: 1 });
  assert.ok(thisGw.pAppear <= 0.25 + 1e-12, 'this gameweek must respect the published chance');

  // Gameweek 3 is a double for club 1 in this fixture list, so the comparison
  // is made per fixture through the availability the model applied.
  const later = projectMinutes(doubtful, { gameState: live, gw: 3 });
  assert.ok(later.availability > thisGw.availability, 'a doubt two gameweeks out is smaller');
  assert.ok(later.availability < 1, 'but it is still a doubt');
  assert.match(later.reason, /recovering/);
});

test('calibration bins predicted start probability against observed starts', () => {
  const rng = makeRng(5);
  const rows = [];
  for (let i = 0; i < 4000; i++) {
    const pStart = rng();
    rows.push({ pStart, started: rng() < pStart });
  }
  const report = calibration(rows, { bins: 10 });
  assert.equal(report.n, 4000);
  assert.equal(report.bins.length, 10);
  // Perfectly calibrated data must come back calibrated.
  assert.ok(report.ece < 0.05, `ece ${report.ece}`);
  assert.ok(Math.abs(report.meanPredicted - report.observedRate) < 0.03);
  for (const b of report.bins) {
    assert.ok(b.n > 0);
    assert.ok(Math.abs(b.meanPredicted - b.observedRate) < 0.12, `bin ${b.lo}-${b.hi} gap`);
  }
});

test('calibration exposes a biased model rather than hiding it', () => {
  const rng = makeRng(11);
  const rows = [];
  for (let i = 0; i < 3000; i++) {
    const truth = rng();
    // The model claims a much higher start rate than reality.
    rows.push({ pStart: Math.min(1, truth + 0.3), started: rng() < truth });
  }
  const report = calibration(rows, { bins: 10 });
  assert.ok(report.ece > 0.15, `a 0.3 bias should show up, ece was ${report.ece}`);
  assert.ok(report.meanPredicted > report.observedRate);
});
