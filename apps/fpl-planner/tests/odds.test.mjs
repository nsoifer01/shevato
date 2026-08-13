import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MARGIN_METHODS,
  ODDS_PARAMS,
  impliedProbabilities,
  normalizeFixtureOdds,
  chooseTotalsLine,
  totalGoalsFromOverUnder,
  outcomeProbs,
  supremacyFromMatchOdds,
  deriveFromOdds,
  assertAdapter,
  loadOdds,
  theOddsApiAdapter,
  averageProbabilities,
} from '../js/engine/odds.js';

import { projectFixture, MAX_GOALS } from '../js/engine/fixtures.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// A book chosen so every expectation in this file is an exact fraction rather
// than a number copied out of a debugger.
//
//   1 / 1.80 = 5/9  = 10/18
//   1 / 3.60 = 5/18
//   1 / 4.50 = 2/9  =  4/18
//   booksum  = 19/18 = 1.0555..., an overround of 5.55%
const BOOK = [1.8, 3.6, 4.5];

// ---------------------------------------------------------------------------
// Margin removal
// ---------------------------------------------------------------------------

test('the raw inverse odds of a real book do not sum to 1', () => {
  const inv = BOOK.map(o => 1 / o);
  const booksum = inv.reduce((a, b) => a + b, 0);
  assert.ok(close(booksum, 19 / 18), `${booksum}`);
  assert.ok(booksum > 1, 'this fixture must be an over-round book or the rest of the file proves nothing');
});

test('every margin method turns that book into probabilities summing to exactly 1', () => {
  for (const method of MARGIN_METHODS) {
    const { probs, booksum, overround } = impliedProbabilities(BOOK, { method });
    const total = probs.reduce((a, b) => a + b, 0);
    assert.ok(close(total, 1, 1e-12), `${method} summed to ${total}`);
    assert.ok(close(booksum, 19 / 18), `${method} reported booksum ${booksum}`);
    assert.ok(close(overround, 1 / 18), `${method} reported overround ${overround}`);
  }
});

test('multiplicative removal divides through by the booksum', () => {
  // (5/9) / (19/18) = 10/19, and likewise 5/19 and 4/19.
  const { probs } = impliedProbabilities(BOOK, { method: 'multiplicative' });
  assert.ok(close(probs[0], 10 / 19, 1e-12), `${probs[0]}`);
  assert.ok(close(probs[1], 5 / 19, 1e-12), `${probs[1]}`);
  assert.ok(close(probs[2], 4 / 19, 1e-12), `${probs[2]}`);
});

test('additive removal takes the same slice off every outcome', () => {
  // slice = (19/18 - 1) / 3 = 1/54, so 30/54, 15/54, 12/54 become 29/54, 14/54, 11/54.
  const { probs } = impliedProbabilities(BOOK, { method: 'additive' });
  assert.ok(close(probs[0], 29 / 54, 1e-12), `${probs[0]}`);
  assert.ok(close(probs[1], 14 / 54, 1e-12), `${probs[1]}`);
  assert.ok(close(probs[2], 11 / 54, 1e-12), `${probs[2]}`);
});

test('additive removal refuses a book it cannot handle instead of clamping', () => {
  // A heavy favourite with a 200.0 longshot: an equal slice is bigger than the
  // longshot's whole implied probability, so the method has no valid answer.
  assert.throws(
    () => impliedProbabilities([1.05, 15, 200], { method: 'additive' }),
    /non-positive probability/,
  );
});

test('Shin leaves a fair book exactly alone', () => {
  // 1/2 + 1/4 + 1/4 = 1, so there is no margin, z must be 0 and the implied
  // probabilities must be the inverse odds themselves.
  const { probs, z, overround } = impliedProbabilities([2, 4, 4], { method: 'shin' });
  assert.equal(z, 0);
  assert.ok(close(overround, 0, 1e-15), `${overround}`);
  assert.ok(close(probs[0], 0.5, 1e-15), `${probs[0]}`);
  assert.ok(close(probs[1], 0.25, 1e-15), `${probs[1]}`);
  assert.ok(close(probs[2], 0.25, 1e-15), `${probs[2]}`);
});

test('Shin solves a genuine insider proportion on an over-round book', () => {
  const { probs, z } = impliedProbabilities(BOOK, { method: 'shin' });
  assert.ok(z > 0 && z < 1, `z was ${z}`);
  const total = probs.reduce((a, b) => a + b, 0);
  assert.ok(close(total, 1, 1e-12), `${total}`);
  // Shin's defining equation, checked directly rather than trusting the solver:
  // p_i = ( sqrt(z^2 + 4 (1-z) inv_i^2 / B) - z ) / (2 (1-z)).
  const inv = BOOK.map(o => 1 / o);
  const B = inv.reduce((a, b) => a + b, 0);
  inv.forEach((v, i) => {
    const expected = (Math.sqrt(z * z + (4 * (1 - z) * v * v) / B) - z) / (2 * (1 - z));
    assert.ok(close(probs[i], expected, 1e-9), `outcome ${i}: ${probs[i]} vs ${expected}`);
  });
});

test('Shin is the default because it moves probability toward the favourite', () => {
  // This is the whole reason Shin is the default rather than the simpler
  // multiplicative method. Bookmakers load their margin onto longshots, so
  // dividing through by the booksum leaves the favourite understated. If this
  // ordering ever flips, the choice of default is no longer justified.
  const shin = impliedProbabilities(BOOK, { method: 'shin' }).probs;
  const mult = impliedProbabilities(BOOK, { method: 'multiplicative' }).probs;
  assert.ok(shin[0] > mult[0], `favourite: shin ${shin[0]} should exceed multiplicative ${mult[0]}`);
  assert.ok(shin[2] < mult[2], `longshot: shin ${shin[2]} should fall below multiplicative ${mult[2]}`);
  assert.equal(ODDS_PARAMS.marginMethod, 'shin');
});

test('unusable prices are rejected rather than silently inverted', () => {
  assert.throws(() => impliedProbabilities([1.0, 3.6, 4.5]), /greater than 1/);
  assert.throws(() => impliedProbabilities([0.9, 3.6, 4.5]), /greater than 1/);
  assert.throws(() => impliedProbabilities([NaN, 3.6, 4.5]), /finite number/);
  assert.throws(() => impliedProbabilities([1.8]), /at least two outcomes/);
  assert.throws(() => impliedProbabilities(BOOK, { method: 'wishful' }), /unknown margin method/);
});

// ---------------------------------------------------------------------------
// The normalized shape
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  source: 'test-book',
  fetchedAt: '2024-09-13T17:30:00Z',
  fixtureId: 'abc123',
  homeTeamId: 1,
  awayTeamId: 2,
  commenceTime: '2024-09-14T14:00:00Z',
  h2h: { home: 1.8, draw: 3.6, away: 4.5 },
  totals: [{ line: 2.5, over: 1.9, under: 2.0, bookmakerCount: 6 }],
  bookmakerCount: 6,
};

test('the normalized shape carries the source and the snapshot time through', () => {
  const n = normalizeFixtureOdds(SNAPSHOT);
  assert.equal(n.source, 'test-book');
  assert.equal(n.fetchedAt, '2024-09-13T17:30:00Z');
  assert.equal(n.homeTeamId, 1);
  assert.equal(n.awayTeamId, 2);
  assert.equal(n.commenceTime, '2024-09-14T14:00:00Z');
  assert.equal(n.marginMethod, 'shin');
  assert.ok(close(n.pHome + n.pDraw + n.pAway, 1, 1e-12));
  assert.ok(n.pHome > n.pDraw && n.pDraw > n.pAway, 'the 1.80 shot must come out as the favourite');
});

test('a snapshot with no source or no timestamp is refused', () => {
  assert.throws(() => normalizeFixtureOdds({ ...SNAPSHOT, source: null }), /source name is required/);
  assert.throws(() => normalizeFixtureOdds({ ...SNAPSHOT, fetchedAt: null }), /fetchedAt/);
  assert.throws(() => normalizeFixtureOdds({ ...SNAPSHOT, homeTeamId: null }), /homeTeamId/);
  assert.throws(() => normalizeFixtureOdds({ ...SNAPSHOT, h2h: null }), /h2h market is required/);
});

test('the over/under book is de-margined the same way as the match book', () => {
  const n = normalizeFixtureOdds(SNAPSHOT);
  const t = n.totals[0];
  assert.equal(t.line, 2.5);
  assert.ok(close(t.pOver + t.pUnder, 1, 1e-12), `${t.pOver + t.pUnder}`);
  // 1/1.9 + 1/2.0 = 0.526316 + 0.5 = 1.026316, so the raw prices overstate by
  // 2.63% and the de-margined pair must sit strictly inside the raw pair.
  assert.ok(t.pOver < 1 / 1.9, `${t.pOver}`);
  assert.ok(t.pUnder < 1 / 2.0, `${t.pUnder}`);
  assert.ok(close(t.overround, 1 / 1.9 + 1 / 2.0 - 1, 1e-12), `${t.overround}`);
});

test('the main totals line is the one most bookmakers quote, ties breaking to 2.5', () => {
  assert.equal(chooseTotalsLine([]), null);
  assert.equal(chooseTotalsLine(null), null);
  const chosen = chooseTotalsLine([
    { line: 3.5, bookmakerCount: 2 },
    { line: 2.5, bookmakerCount: 9 },
    { line: 1.5, bookmakerCount: 4 },
  ]);
  assert.equal(chosen.line, 2.5);
  const tie = chooseTotalsLine([
    { line: 3.5, bookmakerCount: 5 },
    { line: 2.5, bookmakerCount: 5 },
  ]);
  assert.equal(tie.line, 2.5);
});

// ---------------------------------------------------------------------------
// Inverting the markets
// ---------------------------------------------------------------------------

test('the totals market inverts back to the Poisson mean it came from', () => {
  // Hand computation. For a total of exactly 2.5 goals,
  //   P(0) + P(1) + P(2) = e^-2.5 (1 + 2.5 + 2.5^2/2) = e^-2.5 * 6.625
  // so P(over 2.5) = 1 - that. Feeding that price back in must return 2.5.
  const mean = 2.5;
  const pUnderOrEqual2 = Math.exp(-mean) * (1 + mean + (mean * mean) / 2);
  const pOver = 1 - pUnderOrEqual2;
  assert.ok(close(pOver, 0.4561868841, 1e-9), `${pOver}`);
  assert.ok(close(totalGoalsFromOverUnder(2.5, pOver), 2.5, 1e-9));
});

test('a shorter over price means a higher goal environment', () => {
  const low = totalGoalsFromOverUnder(2.5, 0.40);
  const high = totalGoalsFromOverUnder(2.5, 0.60);
  assert.ok(high > low, `${high} should exceed ${low}`);
  // A different line describing the same match must land near the same total.
  const from15 = totalGoalsFromOverUnder(1.5, 1 - Math.exp(-2.5) * (1 + 2.5));
  assert.ok(close(from15, 2.5, 1e-9), `${from15}`);
});

test('an integer totals line is refused because it carries a push', () => {
  assert.throws(() => totalGoalsFromOverUnder(3, 0.5), /not a half line/);
  assert.throws(() => totalGoalsFromOverUnder(0, 0.5), /positive number/);
  assert.throws(() => totalGoalsFromOverUnder(2.5, 0), /strictly between 0 and 1/);
  assert.throws(() => totalGoalsFromOverUnder(2.5, 1), /strictly between 0 and 1/);
});

test('a market with equal win prices implies no supremacy at all', () => {
  const s = supremacyFromMatchOdds(2.5, 0.37, 0.37);
  assert.ok(close(s, 0, 1e-9), `${s}`);
});

test('supremacy moves with the favourite and stays inside the total', () => {
  const home = supremacyFromMatchOdds(2.5, 0.6, 0.2);
  const away = supremacyFromMatchOdds(2.5, 0.2, 0.6);
  assert.ok(home > 0 && away < 0, `${home} / ${away}`);
  assert.ok(close(home, -away, 1e-9), 'the model is symmetric, so mirrored inputs must mirror');
  assert.ok(Math.abs(home) < 2.5, 'supremacy above the total would imply a negative expected goals');
});

// ---------------------------------------------------------------------------
// deriveFromOdds
// ---------------------------------------------------------------------------

test('a symmetric market derives an even split and equal clean sheet chances', () => {
  const mean = 2.5;
  const pOver = 1 - Math.exp(-mean) * (1 + mean + (mean * mean) / 2);
  const normalized = {
    source: 'test-book',
    fetchedAt: '2024-09-13T17:30:00Z',
    homeTeamId: 1,
    awayTeamId: 2,
    pHome: 0.37,
    pDraw: 0.26,
    pAway: 0.37,
    totals: [{ line: 2.5, pOver, pUnder: 1 - pOver, bookmakerCount: 6 }],
  };
  const d = deriveFromOdds(normalized);
  assert.ok(close(d.totalGoals, 2.5, 1e-9), `${d.totalGoals}`);
  assert.equal(d.totalsSource, 'market');
  assert.ok(close(d.xGH, 1.25, 1e-9), `${d.xGH}`);
  assert.ok(close(d.xGA, 1.25, 1e-9), `${d.xGA}`);
  // A clean sheet is the opponent failing to score, which under Poisson is
  // exactly e^-xG.
  assert.ok(close(d.pCSHome, Math.exp(-1.25), 1e-12), `${d.pCSHome}`);
  assert.ok(close(d.pCSAway, Math.exp(-1.25), 1e-12), `${d.pCSAway}`);
  assert.ok(close(d.pWinHome, d.pWinAway, 1e-12));
});

test('the fit reproduces the market split of the decisive outcomes', () => {
  // This is the documented fit target: the draw is conditioned away because
  // independent Poisson goals cannot price it, so what must match is the home
  // share of home-win plus away-win.
  const normalized = normalizeFixtureOdds(SNAPSHOT);
  const d = deriveFromOdds(normalized);
  const marketShare = normalized.pHome / (normalized.pHome + normalized.pAway);
  const modelShare = d.pWinHome / (d.pWinHome + d.pWinAway);
  assert.ok(close(modelShare, marketShare, 1e-9), `${modelShare} vs ${marketShare}`);
  // And the outcome the fit does NOT target is reported rather than buried.
  assert.ok(Number.isFinite(d.drawResidual));
  assert.ok(close(d.drawResidual, d.pDraw - normalized.pDraw, 1e-15));
  assert.ok(Math.abs(d.drawResidual) < 0.05, `Poisson draw is off by ${d.drawResidual}, which is too far to be a modelling quirk`);
});

test('a home favourite derives more goals for and a better clean sheet chance', () => {
  const d = deriveFromOdds(normalizeFixtureOdds(SNAPSHOT));
  assert.ok(d.xGH > d.xGA, `${d.xGH} vs ${d.xGA}`);
  assert.ok(d.supremacy > 0);
  // pCSHome is the AWAY side failing to score, so the stronger home team has
  // the better clean sheet chance.
  assert.ok(d.pCSHome > d.pCSAway, `${d.pCSHome} vs ${d.pCSAway}`);
});

test('a fixture with no goals market is derived from the fallback and says so', () => {
  const d = deriveFromOdds({
    source: 'test-book',
    fetchedAt: '2024-09-13T17:30:00Z',
    pHome: 0.5,
    pDraw: 0.25,
    pAway: 0.25,
    totals: [],
  });
  assert.equal(d.totalsSource, 'fallback');
  assert.ok(close(d.totalGoals, ODDS_PARAMS.fallbackTotalGoals, 1e-12));
  assert.ok(close(d.xGH + d.xGA, ODDS_PARAMS.fallbackTotalGoals, 1e-9));
});

test('derived probabilities are a proper distribution', () => {
  const d = deriveFromOdds(normalizeFixtureOdds(SNAPSHOT));
  assert.ok(close(d.pWinHome + d.pDraw + d.pWinAway, 1, 1e-9));
  assert.ok(close(d.goalsDistH.reduce((a, b) => a + b, 0), 1, 1e-12));
  assert.ok(close(d.goalsDistA.reduce((a, b) => a + b, 0), 1, 1e-12));
  assert.equal(d.goalsDistH.length, MAX_GOALS + 1);
});

test('nonsense probabilities are refused', () => {
  assert.throws(() => deriveFromOdds(null), /needs a normalized/);
  assert.throws(() => deriveFromOdds({ pHome: 1.4, pDraw: 0.2, pAway: 0.2 }), /must be a probability/);
  assert.throws(() => deriveFromOdds({ pHome: 0, pDraw: 1, pAway: 0 }), /no decisive probability/);
});

// ---------------------------------------------------------------------------
// Parity with the model this is meant to be compared against
// ---------------------------------------------------------------------------

test('deriveFromOdds returns every key projectFixture returns', () => {
  // If this fails, the odds path and the ratings path have drifted apart and
  // nothing downstream can consume them interchangeably, which is the entire
  // reason this module exists.
  const strength = {
    leagueMeanGoals: 1.4,
    homeAdvantage: 1.15,
    teams: new Map([
      [1, { teamId: 1, attack: 1.3, defence: 0.85 }],
      [2, { teamId: 2, attack: 0.9, defence: 1.1 }],
    ]),
  };
  const modelKeys = Object.keys(projectFixture(strength, 1, 2)).sort();
  const derived = deriveFromOdds(normalizeFixtureOdds(SNAPSHOT));
  for (const key of modelKeys) {
    assert.ok(key in derived, `deriveFromOdds is missing the fixture-model key "${key}"`);
  }
});

test('the local outcome loop agrees with the fixture model term for term', () => {
  // outcomeProbs duplicates the double loop in fixtures.js on purpose (it takes
  // goal means, not team ids). This is the guard that keeps the duplicate
  // honest.
  const strength = {
    leagueMeanGoals: 1.4,
    homeAdvantage: 1.15,
    teams: new Map([
      [1, { teamId: 1, attack: 1.3, defence: 0.85 }],
      [2, { teamId: 2, attack: 0.9, defence: 1.1 }],
    ]),
  };
  const model = projectFixture(strength, 1, 2);
  const mine = outcomeProbs(model.xGH, model.xGA);
  assert.ok(close(mine.pWinHome, model.pWinHome, 1e-12), `${mine.pWinHome} vs ${model.pWinHome}`);
  assert.ok(close(mine.pDraw, model.pDraw, 1e-12), `${mine.pDraw} vs ${model.pDraw}`);
  assert.ok(close(mine.pWinAway, model.pWinAway, 1e-12), `${mine.pWinAway} vs ${model.pWinAway}`);
  assert.ok(close(mine.goalsDistA[0], model.pCSHome, 1e-12));
  assert.ok(close(mine.goalsDistH[0], model.pCSAway, 1e-12));
});

// ---------------------------------------------------------------------------
// The adapter interface and the (unverified) The Odds API adapter
// ---------------------------------------------------------------------------

const RESOLVE = (name) => ({ Arsenal: 1, Chelsea: 7, 'Nottingham Forest': 16 }[name] ?? null);

const LIVE_PAYLOAD = [
  {
    id: 'e912304de2b2ce35b473ce2ecd3d1502',
    commence_time: '2024-09-14T14:00:00Z',
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    bookmakers: [
      {
        key: 'pinnacle',
        markets: [
          { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.8 }, { name: 'Chelsea', price: 4.5 }, { name: 'Draw', price: 3.6 }] },
          { key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point: 2.5 }, { name: 'Under', price: 2.0, point: 2.5 }] },
        ],
      },
      {
        key: 'williamhill',
        markets: [
          { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 1.75 }, { name: 'Chelsea', price: 4.6 }, { name: 'Draw', price: 3.7 }] },
          {
            key: 'totals',
            outcomes: [
              { name: 'Over', price: 1.95, point: 2.5 },
              { name: 'Under', price: 1.95, point: 2.5 },
              // An integer line, which carries a push and must be dropped
              // rather than inverted.
              { name: 'Over', price: 2.4, point: 3 },
              { name: 'Under', price: 1.55, point: 3 },
            ],
          },
        ],
      },
    ],
  },
];

test('the adapter contract is enforced before anything is fetched', () => {
  assert.throws(() => assertAdapter(null), /must be an object/);
  assert.throws(() => assertAdapter({ describe() {}, buildRequest() {}, parse() {} }), /needs a name/);
  assert.throws(() => assertAdapter({ name: 'x', describe() {}, buildRequest() {} }), /missing parse/);
  assert.equal(assertAdapter(theOddsApiAdapter({ apiKey: 'k' })).name, 'the-odds-api');
});

test('the adapter is honest that it has never seen a real response', () => {
  const d = theOddsApiAdapter({ apiKey: 'k' }).describe();
  assert.equal(d.verified, false);
  assert.equal(d.sport, 'soccer_epl');
  assert.equal(d.historical, true);
  // Two markets across one region: 2 credits live, 10x that historically.
  assert.equal(d.creditsPerLiveRequest, 2);
  assert.equal(d.creditsPerHistoricalRequest, 20);
});

test('buildRequest hits the live endpoint by default and the historical one with a date', () => {
  const adapter = theOddsApiAdapter({ apiKey: 'secret-key' });
  const live = adapter.buildRequest({});
  assert.ok(live.url.includes('/v4/sports/soccer_epl/odds'), live.url);
  assert.ok(!live.url.includes('/historical/'), live.url);
  assert.ok(live.url.includes('oddsFormat=decimal'), live.url);
  assert.ok(live.url.includes('markets=h2h%2Ctotals'), live.url);
  assert.ok(!live.url.includes('date='), live.url);

  const past = adapter.buildRequest({ at: '2024-09-13T17:30:00Z' });
  assert.ok(past.url.includes('/v4/historical/sports/soccer_epl/odds'), past.url);
  assert.ok(past.url.includes('date=2024-09-13T17%3A30%3A00Z'), past.url);
});

test('buildRequest refuses to run without a key rather than sending an anonymous request', () => {
  assert.throws(() => theOddsApiAdapter({}).buildRequest({}), /needs an apiKey/);
});

test('parse turns a live payload into normalized rows with a consensus across books', () => {
  const rows = theOddsApiAdapter({ apiKey: 'k' })
    .parse(LIVE_PAYLOAD, { resolveTeam: RESOLVE, fetchedAt: '2024-09-13T17:30:00Z' });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.source, 'the-odds-api');
  assert.equal(r.fetchedAt, '2024-09-13T17:30:00Z');
  assert.equal(r.homeTeamId, 1);
  assert.equal(r.awayTeamId, 7);
  assert.equal(r.bookmakerCount, 2);
  assert.ok(close(r.pHome + r.pDraw + r.pAway, 1, 1e-12));
  // Each book is de-margined on its own and the probabilities averaged, so the
  // consensus must sit between the two books rather than outside them.
  const a = impliedProbabilities([1.8, 3.6, 4.5]).probs[0];
  const b = impliedProbabilities([1.75, 3.7, 4.6]).probs[0];
  assert.ok(r.pHome > Math.min(a, b) - 1e-12 && r.pHome < Math.max(a, b) + 1e-12, `${r.pHome} outside [${a}, ${b}]`);
  assert.ok(close(r.pHome, (a + b) / 2, 1e-9), `${r.pHome}`);
});

test('parse keeps the half line and drops the integer line', () => {
  const [r] = theOddsApiAdapter({ apiKey: 'k' })
    .parse(LIVE_PAYLOAD, { resolveTeam: RESOLVE, fetchedAt: '2024-09-13T17:30:00Z' });
  assert.deepEqual(r.totals.map(t => t.line), [2.5]);
  assert.equal(r.totals[0].bookmakerCount, 2);
  assert.ok(close(r.totals[0].pOver + r.totals[0].pUnder, 1, 1e-12));
});

test('a historical snapshot is stamped with the snapshot time, not the request time', () => {
  // The single most important property for a backtest: if fetchedAt came from
  // the caller's clock or from the requested date, a snapshot taken after a
  // deadline could be fed into a plan for that gameweek and the leakage would
  // be undetectable.
  const payload = {
    timestamp: '2024-09-13T17:25:00Z',
    previous_timestamp: '2024-09-13T17:20:00Z',
    next_timestamp: '2024-09-13T17:30:00Z',
    data: LIVE_PAYLOAD,
  };
  const [r] = theOddsApiAdapter({ apiKey: 'k' })
    .parse(payload, { resolveTeam: RESOLVE, fetchedAt: '2026-01-01T00:00:00Z' });
  assert.equal(r.fetchedAt, '2024-09-13T17:25:00Z');
});

test('parse fails loudly on a team name it cannot map', () => {
  const stranger = [{ ...LIVE_PAYLOAD[0], away_team: 'Wolverhampton Wanderers' }];
  assert.throws(
    () => theOddsApiAdapter({ apiKey: 'k' }).parse(stranger, { resolveTeam: RESOLVE, fetchedAt: '2024-09-13T17:30:00Z' }),
    /could not map bookmaker team name "Wolverhampton Wanderers"/,
  );
  assert.throws(
    () => theOddsApiAdapter({ apiKey: 'k' }).parse(LIVE_PAYLOAD, { resolveTeam: RESOLVE }),
    /no snapshot timestamp/,
  );
  assert.throws(
    () => theOddsApiAdapter({ apiKey: 'k' }).parse(LIVE_PAYLOAD, {}),
    /needs ctx.resolveTeam/,
  );
  assert.throws(
    () => theOddsApiAdapter({ apiKey: 'k' }).parse({ nope: true }, { resolveTeam: RESOLVE, fetchedAt: 'x' }),
    /neither an event array nor a historical wrapper/,
  );
});

test('loadOdds wires an adapter to an injected fetch and never to a global one', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => LIVE_PAYLOAD };
  };
  const rows = await loadOdds(
    theOddsApiAdapter({ apiKey: 'k' }),
    {},
    { resolveTeam: RESOLVE, fetchedAt: '2024-09-13T17:30:00Z', fetchImpl },
  );
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes('apiKey=k'));
  assert.equal(rows.length, 1);

  await assert.rejects(
    () => loadOdds(theOddsApiAdapter({ apiKey: 'k' }), {}, { fetchImpl }),
    /ctx.resolveTeam/,
  );
  await assert.rejects(
    () => loadOdds(theOddsApiAdapter({ apiKey: 'k' }), {}, {
      resolveTeam: RESOLVE,
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    /HTTP 429/,
  );
});

test('averaging probability vectors renormalizes and rejects ragged input', () => {
  const avg = averageProbabilities([[0.5, 0.3, 0.2], [0.3, 0.3, 0.4]]);
  assert.ok(close(avg[0], 0.4, 1e-12));
  assert.ok(close(avg[1], 0.3, 1e-12));
  assert.ok(close(avg[2], 0.3, 1e-12));
  assert.throws(() => averageProbabilities([]), /empty set/);
  assert.throws(() => averageProbabilities([[0.5, 0.5], [0.3, 0.3, 0.4]]), /different lengths/);
});

// ---------------------------------------------------------------------------
// The whole path, once
// ---------------------------------------------------------------------------

test('a vendor payload becomes fixture-model quantities end to end', () => {
  const rows = theOddsApiAdapter({ apiKey: 'k' })
    .parse(LIVE_PAYLOAD, { resolveTeam: RESOLVE, fetchedAt: '2024-09-13T17:30:00Z' });
  const derived = rows.map(r => deriveFromOdds(r));
  assert.equal(derived.length, 1);
  const d = derived[0];
  assert.equal(d.source, 'the-odds-api');
  assert.equal(d.fetchedAt, '2024-09-13T17:30:00Z');
  assert.equal(d.totalsSource, 'market');
  assert.ok(d.totalGoals > 2 && d.totalGoals < 4, `${d.totalGoals}`);
  assert.ok(d.xGH > d.xGA, 'Arsenal were the favourite in this book');
  assert.ok(d.pCSHome > 0 && d.pCSHome < 1);
  assert.ok(close(d.pWinHome + d.pDraw + d.pWinAway, 1, 1e-9));
});
