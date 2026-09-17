import test from 'node:test';
import assert from 'node:assert/strict';

import {
  projectMinutes,
  positionPriors,
  calibration,
  p60GivenStart,
  p60GivenSub,
  availabilityCeiling,
  horizonSteps,
  MINUTES_PARAMS,
  minutesConfidence,
  confidenceTierFor,
  NO_EVIDENCE_START_SD,
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

// A season already under way: `played` matches for both clubs, this season's
// totals on the payload and the previous season attached as a prior, then the
// gameweek being decided. A player with no minutes in this world has not merely
// failed to prove anything, he has been left out `played` times.
function seasonInProgress(played) {
  return { gameState: inSeasonState(thinLeague(played), { matches: played }), gw: played + 1 };
}

test('the no-history price prior is untouched before a ball is kicked', () => {
  // Every pre-season payload and every gameweek 1 lands here, so this is the
  // guarantee that the decay cannot disturb the opening squad build.
  const gs = makeGameState(LEAGUE);
  const pricey = makePlayer({ minutes: 0, nowCost: 90 });
  const m = projectMinutes(pricey, { gameState: gs, gw: 1 });
  assert.equal(m.reason, 'no-history-prior');
  // The top of the price range is a likely starter, not a certain one: held
  // out, a player with no previous season started 60% of the time at the top
  // price percentile (MINUTES_PARAMS.noHistoryMaxStart).
  assert.ok(m.pStart > 0.5, `a marquee signing should still be a likely starter, got ${m.pStart}`);
  assert.ok(m.pStart <= MINUTES_PARAMS.noHistoryMaxStart + 1e-12);
});

test('the price prior decays by the matches his club played without him', () => {
  // Price is a pre-season signal. Once his club has played, "still on zero
  // minutes" is evidence the price cannot see: the posterior is zero starts in
  // m matches against the price prior worth K = base + perMatch * m matches.
  const pricey = makePlayer({ minutes: 0, nowCost: 90 });
  const { base, perMatch } = MINUTES_PARAMS.noHistoryCarry;

  for (const played of [1, 3, 10, 25]) {
    const { gameState, gw } = seasonInProgress(played);
    const m = projectMinutes(pricey, { gameState, gw });
    assert.equal(m.reason, 'no-history-unplayed');
    const k = base + perMatch * played;
    // The price prior itself, read against this league's price bands.
    const mu = projectMinutes(pricey, { gameState: inSeasonState(thinLeague(0), { matches: 0 }), gw: 1 }).pStart;
    const expected = mu * (k / (played + k));
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
  const { gameState, gw } = seasonInProgress(10);
  const october = projectMinutes(pricey, { gameState, gw });

  assert.ok(october.pStart < august.pStart / 5, `${october.pStart} vs ${august.pStart}`);
  assert.ok(october.pAppear < august.pAppear / 5);
  assert.ok(october.xMins < august.xMins / 5);
  assert.ok(october.pStart > 0, 'never certain, only very unlikely');
});

test('the decay applies to coming off the bench, not only to starting', () => {
  // "Zero minutes after m matches" bears on appearing at all. A player with no
  // minutes this season after his club has played takes the measured rate at
  // which such players come off the bench (MINUTES_PARAMS.subOnUnused), which
  // falls as the matches he has sat out mount up.
  const pricey = makePlayer({ minutes: 0, nowCost: 90 });
  const subOn = (p) => (p.pAppear - p.pStart) / (1 - p.pStart);
  const buckets = MINUTES_PARAMS.subOnUnusedBuckets;
  let previous = Infinity;
  for (const played of [1, 4, 8, 15]) {
    const { gameState, gw } = seasonInProgress(played);
    const m = projectMinutes(pricey, { gameState, gw });
    const bucket = buckets.findIndex(([lo, hi]) => played >= lo && played <= hi);
    const expected = MINUTES_PARAMS.subOnUnused[3][bucket];
    assert.ok(Math.abs(subOn(m) - expected) < 1e-12, `after ${played}: ${subOn(m)} vs ${expected}`);
    assert.ok(expected <= previous, 'sitting out more matches never makes an appearance likelier');
    previous = expected;
    assert.ok(m.pStart <= m.pAppear + 1e-12 && m.pAppear <= 1);
  }
});

test('the decay reads the players own club, not the league', () => {
  // Club 1 has played five matches and club 2 has played none, which is what a
  // run of postponements looks like. The player at the idle club has had no
  // chance to be left out, so nothing about him has been learned yet.
  const gs = inSeasonState(thinLeague(5), { matches: 5 });
  gs.teams.set(3, { id: 3 });
  gs.fixtures = [];
  for (let i = 1; i <= 5; i++) {
    gs.fixtures.push({ id: i, event: i, teamH: 1, teamA: 3, started: true, finished: true, finishedProvisional: true, teamHScore: 1, teamAScore: 0 });
  }
  gs.fixtures.push({ id: 90, event: 6, teamH: 1, teamA: 2, started: false, finished: false, teamHScore: null, teamAScore: null });
  for (const p of gs.players.values()) if (p.teamId === 2) { p.starts = 0; p.minutes = 0; }

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

test('confidence measures how well the minutes are known, not how many there are', () => {
  const gs = makeGameState(LEAGUE);
  const nailed = projectMinutes(makePlayer({ minutes: 3200, starts: 36 }), { gameState: gs, gw: 1 });
  const some = projectMinutes(makePlayer({ minutes: 500, starts: 5 }), { gameState: gs, gw: 1 });

  // A full season of evidence, either way round. The nailed starter and the
  // settled squad player are both WELL KNOWN; that they are known to be very
  // different players is what pStart is for, and it says so.
  assert.equal(nailed.confidence, 'high');
  assert.equal(some.confidence, 'high');
  assert.ok(nailed.pStart > 0.8);
  assert.ok(some.pStart < 0.3);
});

test('the tier is derived from the score and the two can never disagree', () => {
  const gs = makeGameState(LEAGUE);
  for (const over of [{ minutes: 3200, starts: 36 }, { minutes: 500, starts: 5 }, { minutes: 90, starts: 1 }, {}]) {
    const r = projectMinutes(makePlayer(over), { gameState: gs, gw: 1 });
    assert.equal(r.confidence, confidenceTierFor(r.confidenceScore));
    assert.ok(r.confidenceScore >= 0 && r.confidenceScore <= 1);
  }
});

test('p60 given a start is measured by position, and rises with typical starter minutes', () => {
  // A starting goalkeeper reaches the hour 99.1% of the time in the archive; a
  // flat logistic on his starter minutes read 0.87-0.90 and cost him an
  // appearance point and a clean sheet in one start in ten.
  for (const minutes of [60, 75, 85, 90]) {
    assert.ok(p60GivenStart(1, minutes) >= 0.98, `keeper at ${minutes}: ${p60GivenStart(1, minutes)}`);
  }
  for (const position of [2, 3]) {
    let prev = -1;
    for (let m = 40; m <= 90; m += 5) {
      const v = p60GivenStart(position, m);
      assert.ok(v >= prev, 'p60 must be non-decreasing in starter minutes');
      assert.ok(v >= 0 && v <= 1);
      prev = v;
    }
    assert.ok(p60GivenStart(position, 88) > 0.95, 'a ninety-minute regular reaches the hour');
    assert.ok(p60GivenStart(position, 50) < 0.2, 'a regular early substitution does not');
  }
  assert.ok(p60GivenStart(4, 85) > 0.9 && p60GivenStart(4, 85) < 0.95);
  for (const position of [1, 2, 3, 4]) {
    assert.ok(p60GivenSub(position) >= 0 && p60GivenSub(position) < 0.1, 'a substitute rarely reaches the hour');
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

// --- season-aware confidence ----------------------------------------------
//
// The tiers used to be cumulative-minute thresholds (900 / 270), which are
// late-season numbers with no season attached: before roughly gameweek 10 they
// described nothing, and at gameweek 4 `high` was arithmetically unreachable
// because 270 was every minute that had been played. These pin the replacement.

test('confidence rises with the season instead of stepping at a fixed minute count', () => {
  // A club has played g matches; the player has started every one of them, so
  // this is the best evidence anyone can carry at that point in the season.
  const scores = [1, 2, 3, 4, 6, 10, 19, 38]
    .map(g => minutesConfidence({ startRate: 1, evidenceMatches: g }).score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] > scores[i - 1], 'more matches must mean more confidence');
  }
  // The old thresholds made `high` arithmetically unreachable before gameweek
  // 10 and `medium` unreachable before gameweek 3, for everyone, whatever they
  // had done. Both are now reachable on a player's own evidence, well before
  // the 900 and 270 minute marks that used to gate them.
  assert.equal(minutesConfidence({ startRate: 1, evidenceMatches: 3 }).tier, 'medium');
  assert.equal(minutesConfidence({ startRate: 1, evidenceMatches: 10 }).tier, 'high');
});

test('the top tier is reachable in gameweek 1 on prior-season evidence', () => {
  // The live gate is `evidenceMatches`, which normalize.js blends from the
  // season baseline, so an established starter is not held at `low` by the
  // calendar. A genuine newcomer with one match behind him is `low` because he
  // has one match of evidence, which is a fact about him and not about the date.
  assert.equal(minutesConfidence({ startRate: 0.95, evidenceMatches: 38 + 1 }).tier, 'high');
  assert.equal(minutesConfidence({ startRate: 1, evidenceMatches: 1 }).tier, 'low');
});

test('an established starter carries his prior season into gameweek 1', () => {
  // evidenceMatches is the blended denominator, so a returning regular arrives
  // with a season behind him and reaches the top tier before a ball is kicked.
  const returning = minutesConfidence({ startRate: 0.95, evidenceMatches: 38 });
  const debutant = minutesConfidence({ startRate: 0.95, evidenceMatches: 0 });
  assert.equal(returning.tier, 'high');
  assert.equal(debutant.tier, 'low');
  assert.equal(debutant.score, 0, 'no evidence is the uniform prior, which scores zero');
});

test('a single observation increases confidence without conferring certainty', () => {
  const one = minutesConfidence({ startRate: 1, evidenceMatches: 1 });
  assert.ok(one.score > 0, 'one match is more than none');
  assert.ok(one.score < 0.35, 'one match is nowhere near certainty');
  const many = minutesConfidence({ startRate: 1, evidenceMatches: 30 });
  assert.ok(many.score > 3 * one.score);
});

test('a coin-flip rotation risk is less known than either extreme on the same sample', () => {
  const n = 12;
  const nailed = minutesConfidence({ startRate: 0.95, evidenceMatches: n }).score;
  const never = minutesConfidence({ startRate: 0.05, evidenceMatches: n }).score;
  const rota = minutesConfidence({ startRate: 0.5, evidenceMatches: n }).score;
  assert.ok(nailed > rota, 'a nailed starter is better known than a rotation risk');
  assert.ok(never > rota, 'a settled non-starter is better known than a rotation risk');
});

test('a published doubt costs confidence directly', () => {
  const fit = minutesConfidence({ startRate: 0.95, evidenceMatches: 30, availability: 1 });
  const doubt = minutesConfidence({ startRate: 0.95, evidenceMatches: 30, availability: 0.5 });
  assert.ok(doubt.score < fit.score);
  assert.ok(Math.abs(doubt.score - fit.score * 0.5) < 1e-12, 'availability scales the score');
});

test('the score is bounded, and the worst case is the no-evidence prior', () => {
  assert.ok(Math.abs(NO_EVIDENCE_START_SD - Math.sqrt(1 / 12)) < 1e-12);
  for (const n of [0, 1, 3, 7, 20, 38, 200]) {
    for (const p of [0, 0.15, 0.5, 0.85, 1]) {
      const { score } = minutesConfidence({ startRate: p, evidenceMatches: n });
      assert.ok(score >= 0 && score <= 1, `score out of range at n=${n} p=${p}`);
    }
  }
});

test('the same minutes read differently at different points in the season', () => {
  // 195 minutes after 3 matches is a regular; after 15 it is a fringe player.
  // The MODEL separates them where the difference belongs, in the start rate,
  // and reports the later one as better known, which it is.
  const early = minutesConfidence({ startRate: 195 / 270, evidenceMatches: 3 });
  const late = minutesConfidence({ startRate: 195 / 1350, evidenceMatches: 15 });
  assert.ok(late.score > early.score, 'fifteen matches is a bigger sample than three');
  assert.notEqual(early.tier, 'high', 'three matches cannot be conclusive');
});

// --- the thin-evidence regime (the 2026-09-16 audit) ------------------------
//
// A season a few matches old, the previous season attached to every returning
// player as a prior (normalize.js). Until 2026-09-16 a player who had started
// every match was pulled 60% of the way to the start rate of every player with
// a minute to his name, and one who had never come off the bench could not come
// off it: an ever-present projected 0.64 (forward) to 0.76 (defender) to
// start and exactly that to appear, while a rotation player with two appearances
// as a substitute was a certain appearance.

function inSeasonState(players, { matches = 4 } = {}) {
  const fixtures = [];
  for (let i = 1; i <= matches; i++) {
    fixtures.push({
      id: i, event: i, teamH: 1, teamA: 2, started: true, finished: true, finishedProvisional: true,
      teamHScore: 1, teamAScore: 0,
    });
  }
  fixtures.push({ id: 100, event: matches + 1, teamH: 1, teamA: 2, started: false, finished: false, teamHScore: null, teamAScore: null });
  const map = new Map();
  let id = 1;
  for (const p of players) map.set(id, { ...p, id: id++ });
  return {
    rules: { starters: 11, totalEvents: 38 },
    teams: new Map([[1, { id: 1 }], [2, { id: 2 }]]),
    players: map,
    fixtures,
    nextEvent: matches + 1,
    priorSeason: { totalEvents: 38, rates: 'carried' },
  };
}

const priorOf = (starts, minutes) => ({ starts, minutes, matches: 38, rates: true });

// A league of regulars, rotation players and substitutes, each with a previous
// season, so the position pools are not degenerate.
function thinLeague(matches) {
  const out = [];
  for (let t = 1; t <= 2; t++) {
    for (let pos = 1; pos <= 4; pos++) {
      out.push(makePlayer({ teamId: t, position: pos, starts: matches, minutes: 90 * matches, prior: priorOf(35, 3100) }));
      out.push(makePlayer({ teamId: t, position: pos, starts: Math.floor(matches / 2), minutes: 80 * Math.floor(matches / 2) + 20 * Math.ceil(matches / 2), prior: priorOf(18, 1800) }));
      out.push(makePlayer({ teamId: t, position: pos, starts: 0, minutes: 20 * matches, prior: priorOf(4, 700) }));
      out.push(makePlayer({ teamId: t, position: pos, starts: 0, minutes: 0, prior: null, nowCost: 40 }));
    }
  }
  return out;
}

test('a player who has started every match projects as a likely starter at every position', () => {
  for (const matches of [2, 4, 8]) {
    const gs = inSeasonState(thinLeague(matches), { matches });
    for (const position of [1, 2, 3, 4]) {
      const nailed = makePlayer({ position, starts: matches, minutes: 90 * matches, prior: priorOf(34, 3000) });
      const m = projectMinutes(nailed, { gameState: gs, gw: matches + 1 });
      assert.ok(m.pStart >= 0.88, `position ${position} after ${matches}: pStart ${m.pStart.toFixed(3)}`);
      assert.ok(m.xMins >= 75, `position ${position} after ${matches}: xMins ${m.xMins.toFixed(1)}`);
    }
  }
});

test('starting every match counts for a newcomer too, without a previous season', () => {
  const gs = inSeasonState(thinLeague(4), { matches: 4 });
  const newcomer = makePlayer({ position: 2, starts: 4, minutes: 360, prior: null, nowCost: 55 });
  const m = projectMinutes(newcomer, { gameState: gs, gw: 5 });
  assert.ok(m.pStart >= 0.8, `pStart ${m.pStart}`);
  const { base, perMatch } = MINUTES_PARAMS.noHistoryCarry;
  assert.ok(m.pStart > (4 + (base + perMatch * 4) * MINUTES_PARAMS.noHistoryMinStart) / (4 + base + perMatch * 4) - 1e-12,
    'four starts in four outweigh even the lowest price prior');
});

test('the start probability is the documented posterior, exactly', () => {
  const gs = inSeasonState(thinLeague(4), { matches: 4 });
  const player = makePlayer({ position: 3, starts: 3, minutes: 270, prior: priorOf(20, 1900) });
  const m = projectMinutes(player, { gameState: gs, gw: 5 });
  // Last season's pooled midfield start rate over every returning player.
  let starts = 0;
  let matches = 0;
  for (const p of gs.players.values()) {
    if (p.position !== 3 || !p.prior || !(p.prior.minutes > 0)) continue;
    starts += p.prior.starts;
    matches += 38;
  }
  const lastRate = starts / matches;
  const k0 = MINUTES_PARAMS.startPriorSeasonShrink;
  const raw = (20 + k0 * lastRate) / (38 + k0);
  const { a, b } = MINUTES_PARAMS.startPriorCalibration;
  const mu = 1 / (1 + Math.exp(-(a + b * Math.log(raw / (1 - raw)))));
  const K = MINUTES_PARAMS.startCarry.base + MINUTES_PARAMS.startCarry.perMatch * 4;
  assert.ok(Math.abs(m.pStart - (3 + K * mu) / (4 + K)) < 1e-12, `${m.pStart} vs ${(3 + K * mu) / (4 + K)}`);
});

test('no bench opportunities is not evidence that a player never comes off the bench', () => {
  const gs = inSeasonState(thinLeague(4), { matches: 4 });
  for (const position of [2, 3, 4]) {
    const nailed = makePlayer({ position, starts: 4, minutes: 360, prior: priorOf(34, 3000) });
    const m = projectMinutes(nailed, { gameState: gs, gw: 5 });
    assert.ok(m.subOnRate > 0.1, `position ${position}: sub-on ${m.subOnRate}`);
    assert.ok(m.pAppear > m.pStart, 'he can still appear when he does not start');
  }
});

test('a nailed starter is never systematically less likely to appear than a rotation player', () => {
  // The inversion the audit found: Saka 0.697 to appear, Mac Allister 1.000.
  // Swept over positions, season lengths and previous seasons, the player who
  // has started every match must appear at least as often as one who has
  // started half and come off the bench in the rest.
  for (const matches of [1, 2, 3, 4, 6, 10, 20]) {
    const gs = inSeasonState(thinLeague(matches), { matches });
    for (const position of [1, 2, 3, 4]) {
      for (const [lastStarts, lastMinutes] of [[35, 3100], [20, 2000], [8, 900], [null, null]]) {
        const prior = lastStarts === null ? null : priorOf(lastStarts, lastMinutes);
        const nailed = projectMinutes(makePlayer({ position, starts: matches, minutes: 90 * matches, prior }), { gameState: gs, gw: matches + 1 });
        const half = Math.floor(matches / 2);
        const rotation = projectMinutes(makePlayer({ position, starts: half, minutes: 85 * half + 25 * (matches - half), prior }), { gameState: gs, gw: matches + 1 });
        assert.ok(nailed.pAppear >= rotation.pAppear - 0.02,
          `position ${position}, ${matches} matches, prior ${lastStarts}: nailed ${nailed.pAppear.toFixed(3)} < rotation ${rotation.pAppear.toFixed(3)}`);
        assert.ok(nailed.pStart > rotation.pStart);
      }
    }
  }
});

test('a starting goalkeeper almost always reaches the hour', () => {
  const gs = inSeasonState(thinLeague(4), { matches: 4 });
  const keeper = makePlayer({ position: 1, starts: 4, minutes: 360, prior: priorOf(37, 3330) });
  const m = projectMinutes(keeper, { gameState: gs, gw: 5 });
  assert.ok(m.p60GivenStart >= 0.98);
  assert.ok(m.p60 / m.pStart >= 0.98 - 1e-9);
});
