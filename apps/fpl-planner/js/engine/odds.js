// Bookmaker odds as a model input.
//
// STATUS: INERT. Nothing imports this module. It exists so that the day an odds
// account exists the integration is a wiring job rather than a design job, and
// so the maths can be argued about and tested before any money is spent. Do not
// import it from the live path until the evaluation in
// `experiments/odds-evaluation-plan.md` has actually been run and passed.
//
// THE PIPELINE
//
//   OddsAdapter (vendor JSON)
//     -> normalizeFixtureOdds  (de-margined market probabilities, one shape)
//     -> deriveFromOdds        (the SAME quantities fixtures.js produces)
//     -> fixture model / player projections
//
// The point of the middle two steps is that no module downstream of this one
// ever sees a vendor's response schema, and that the odds path and the ratings
// path speak the same language. `deriveFromOdds` returns every key
// `projectFixture` returns (xGH, xGA, pCSHome, pCSAway, pWinHome, pDraw,
// pWinAway, goalsDistH, goalsDistA), which is what makes "compare them" or
// "blend them" a one-line decision later rather than a refactor. A test asserts
// that key parity against the real `fixtures.js` so the two cannot drift.
//
// MARGIN REMOVAL. Decimal odds carry the bookmaker's margin: the inverse odds
// of a market sum to more than 1 (the overround). Three methods are
// implemented and the default is SHIN.
//
//   multiplicative  p_i = (1/o_i) / B.  Simplest, and the one everybody
//                   reaches for first. It removes the margin in proportion to
//                   the implied probability, which assumes the book applies its
//                   margin evenly. It does not: the margin is concentrated on
//                   longshots, so this method systematically overstates
//                   longshots and understates favourites.
//   additive        p_i = 1/o_i - (B - 1)/n.  Removes an equal slice from each
//                   outcome, the opposite extreme, and can produce a negative
//                   probability on a lopsided book.
//   shin            Solves for the proportion z of insider money that explains
//                   the observed overround, then backs out the probabilities
//                   the book must hold to break even against it. It reproduces
//                   the favourite-longshot pattern instead of assuming it away,
//                   and in published comparisons on football 1X2 books it is
//                   the best calibrated of the closed-form methods. It costs a
//                   one-dimensional bisection, which is nothing.
//
// Shin is the default because the quantity we care about, a team's expected
// goals, is derived from the FAVOURITE side of the book more than the longshot
// side, and a method with a known bias against favourites would push that
// straight into the projection.
//
// WHY THE DRAW IS HANDLED THE WAY IT IS. Independent Poisson goals cannot
// reproduce a real 1X2 book exactly: the draw is the outcome the independence
// assumption gets wrong (real scorelines are mildly correlated, which is what
// the Dixon-Coles low-score correction exists to fix). So the fit does not try
// to match all three prices. It matches the total goals from the over/under
// market, which is EXACT under Poisson because the sum of two independent
// Poisson counts is Poisson with the summed mean, and then it matches the home
// share of the two decisive outcomes, pHome / (pHome + pAway), which conditions
// the draw away. The leftover disagreement on the draw is reported as
// `drawResidual` rather than hidden, because its size is the honest measure of
// how badly the Poisson assumption fits that fixture.

import { poissonVector } from './ml.js';
import { MAX_GOALS } from './fixtures.js';

export const MARGIN_METHODS = Object.freeze(['shin', 'multiplicative', 'additive']);

export const ODDS_PARAMS = Object.freeze({
  // Shin, for the reasons in the header.
  marginMethod: 'shin',
  // Used only when a fixture has no usable over/under market. Roughly the
  // Premier League mean of goals per match over recent seasons. A derived
  // fixture that leans on it is stamped `totalsSource: 'fallback'` so a caller
  // can weight it down or refuse it.
  fallbackTotalGoals: 2.75,
  // Bisection budget. 200 halvings of a bracket of width 15 is far below double
  // precision, so this bound only exists so a pathological input terminates.
  solverIterations: 200,
  solverTolerance: 1e-12,
  // A total this large is not a football match, it is a bad input.
  maxTotalGoals: 15,
});

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function assertOdds(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`odds: ${label} must be a finite number, got ${JSON.stringify(value)}`);
  }
  // Decimal odds of 1.0 mean a certainty and 1.0 or below means a book that
  // cannot be inverted. Either is a broken feed, not a market.
  if (value <= 1) throw new Error(`odds: ${label} must be greater than 1, got ${value}`);
}

// ---------------------------------------------------------------------------
// Margin removal
// ---------------------------------------------------------------------------

// Shin's method. `inv` are the raw inverse odds, B their sum.
//
//   p_i(z) = ( sqrt( z^2 + 4 (1 - z) inv_i^2 / B ) - z ) / ( 2 (1 - z) )
//
// and z is chosen so that the p_i sum to 1. At z = 0 the expression collapses
// to inv_i / sqrt(B), whose sum is sqrt(B) and therefore exceeds 1 for any
// over-round book; as z rises the sum falls. One sign change, so bisection is
// both sufficient and safe.
function shinProbabilities(inv) {
  const B = sum(inv);
  // A fair or under-round book (B <= 1) has no insider margin to strip. Shin's
  // z is zero there and the method degenerates to plain normalization, which is
  // also what any sane fallback would do.
  if (B <= 1) return { probs: inv.map(v => v / B), z: 0 };

  const at = (z) => {
    const denom = 2 * (1 - z);
    return inv.map(v => (Math.sqrt(z * z + (4 * (1 - z) * v * v) / B) - z) / denom);
  };

  let lo = 0;
  let hi = 1 - 1e-12;
  for (let i = 0; i < ODDS_PARAMS.solverIterations; i++) {
    const mid = (lo + hi) / 2;
    const s = sum(at(mid));
    if (Math.abs(s - 1) < ODDS_PARAMS.solverTolerance) {
      lo = mid;
      hi = mid;
      break;
    }
    if (s > 1) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  const probs = at(z);
  // The bisection lands within 1e-12 of a unit sum; the final normalization
  // makes it exact, because everything downstream assumes these sum to 1.
  const total = sum(probs);
  return { probs: probs.map(p => p / total), z };
}

// Decimal odds -> probabilities with the bookmaker margin removed.
export function impliedProbabilities(decimalOdds, { method = ODDS_PARAMS.marginMethod } = {}) {
  if (!Array.isArray(decimalOdds) || decimalOdds.length < 2) {
    throw new Error('odds: impliedProbabilities needs at least two outcomes');
  }
  if (!MARGIN_METHODS.includes(method)) {
    throw new Error(`odds: unknown margin method ${method}, expected one of ${MARGIN_METHODS.join(', ')}`);
  }
  decimalOdds.forEach((o, i) => assertOdds(o, `outcome ${i} price`));

  const inv = decimalOdds.map(o => 1 / o);
  const booksum = sum(inv);

  let probs;
  let z = 0;
  if (method === 'multiplicative') {
    probs = inv.map(v => v / booksum);
  } else if (method === 'additive') {
    const slice = (booksum - 1) / inv.length;
    probs = inv.map(v => v - slice);
    if (probs.some(p => p <= 0)) {
      // This is the documented failure mode of the additive method, and it is
      // reported rather than clamped: a clamp would return a set that does not
      // sum to 1 and would be silently wrong.
      throw new Error('odds: additive margin removal produced a non-positive probability on this book');
    }
  } else {
    const shin = shinProbabilities(inv);
    probs = shin.probs;
    z = shin.z;
  }

  return {
    probs,
    booksum,
    // The overround expressed the way a trader says it: 1.055 is a 5.5% book.
    overround: booksum - 1,
    method,
    z,
  };
}

// ---------------------------------------------------------------------------
// The normalized shape
//
// One object per fixture, per snapshot. Everything downstream reads this and
// nothing downstream reads a vendor payload.
//
//   { source, fetchedAt, fixtureId, homeTeamId, awayTeamId, commenceTime,
//     pHome, pDraw, pAway, overround, marginMethod, bookmakerCount,
//     totals: [ { line, pOver, pUnder, overround, bookmakerCount } ] }
//
// `source` is the provider name and `fetchedAt` is when the snapshot was taken,
// not when we parsed it. For a historical backfill `fetchedAt` is the snapshot
// timestamp the provider returned, and it is the field the leakage check reads:
// a snapshot stamped after a gameweek deadline must never reach a plan for that
// gameweek.
// ---------------------------------------------------------------------------

export function normalizeFixtureOdds(input, { marginMethod = ODDS_PARAMS.marginMethod } = {}) {
  const {
    source, fetchedAt, fixtureId = null, homeTeamId, awayTeamId,
    commenceTime = null, h2h, totals = [], bookmakerCount = null,
  } = input || {};

  if (!source || typeof source !== 'string') throw new Error('odds: source name is required');
  if (!fetchedAt || typeof fetchedAt !== 'string') throw new Error('odds: fetchedAt ISO timestamp is required');
  if (homeTeamId === undefined || homeTeamId === null) throw new Error('odds: homeTeamId is required');
  if (awayTeamId === undefined || awayTeamId === null) throw new Error('odds: awayTeamId is required');
  if (!h2h) throw new Error('odds: a three-way h2h market is required');

  const { probs, overround } = impliedProbabilities([h2h.home, h2h.draw, h2h.away], { method: marginMethod });

  const normalizedTotals = totals.map(t => {
    const two = impliedProbabilities([t.over, t.under], { method: marginMethod });
    return {
      line: t.line,
      pOver: two.probs[0],
      pUnder: two.probs[1],
      overround: two.overround,
      bookmakerCount: t.bookmakerCount ?? null,
    };
  });

  return {
    source,
    fetchedAt,
    fixtureId,
    homeTeamId,
    awayTeamId,
    commenceTime,
    pHome: probs[0],
    pDraw: probs[1],
    pAway: probs[2],
    overround,
    marginMethod,
    bookmakerCount,
    totals: normalizedTotals,
  };
}

// Which over/under line to invert. The main line is the one the book is most
// balanced on, which in practice is the one with the most bookmakers quoting
// it; ties break toward 2.5, the Premier League standard line.
export function chooseTotalsLine(totals) {
  if (!totals || totals.length === 0) return null;
  let best = null;
  for (const t of totals) {
    if (!best) { best = t; continue; }
    const bn = best.bookmakerCount ?? 0;
    const tn = t.bookmakerCount ?? 0;
    if (tn > bn) { best = t; continue; }
    if (tn === bn && Math.abs(t.line - 2.5) < Math.abs(best.line - 2.5)) best = t;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Inverting the markets into Poisson means
// ---------------------------------------------------------------------------

// Total goals implied by an over/under price.
//
// H + A is Poisson(xGH + xGA) exactly when H and A are independent Poissons, so
// the totals market pins the SUM without saying anything about the split. That
// is the whole reason this is a clean one-dimensional root find rather than an
// optimizer: P(total > line) is strictly increasing in the mean.
//
// Only half lines are accepted. An integer line (over/under 3 goals) is a push
// on exactly 3, so its two prices do not partition the outcome space and
// inverting them without push handling would silently misprice the market.
export function totalGoalsFromOverUnder(line, pOver, opts = {}) {
  const maxTotal = opts.maxTotalGoals ?? ODDS_PARAMS.maxTotalGoals;
  if (typeof line !== 'number' || !Number.isFinite(line) || line <= 0) {
    throw new Error(`odds: totals line must be a positive number, got ${line}`);
  }
  if (Math.abs(line * 2 - Math.round(line * 2)) > 1e-9 || Math.round(line * 2) % 2 === 0) {
    throw new Error(`odds: totals line ${line} is not a half line; integer lines carry a push and are not invertible here`);
  }
  if (!(pOver > 0) || !(pOver < 1)) {
    throw new Error(`odds: pOver must be strictly between 0 and 1, got ${pOver}`);
  }

  const k = Math.floor(line);
  const overAt = (mean) => {
    const v = poissonVector(mean, Math.max(k + 1, 1));
    let under = 0;
    for (let i = 0; i <= k; i++) under += v[i];
    return 1 - under;
  };

  let lo = 1e-9;
  let hi = maxTotal;
  if (pOver >= overAt(hi)) return hi;
  for (let i = 0; i < ODDS_PARAMS.solverIterations; i++) {
    const mid = (lo + hi) / 2;
    if (overAt(mid) < pOver) lo = mid;
    else hi = mid;
    if (hi - lo < ODDS_PARAMS.solverTolerance) break;
  }
  return (lo + hi) / 2;
}

// The outcome distribution for a pair of Poisson means. Deliberately the same
// double loop, the same truncation and the same folded tail as
// `projectFixture` in fixtures.js, so the two are comparable term by term. The
// tests assert they agree to 1e-12 for equivalent inputs, which is what stops
// the duplication turning into a divergence.
export function outcomeProbs(xGH, xGA, maxGoals = MAX_GOALS) {
  const goalsDistH = poissonVector(xGH, maxGoals);
  const goalsDistA = poissonVector(xGA, maxGoals);
  let pWinHome = 0;
  let pDraw = 0;
  let pWinAway = 0;
  for (let h = 0; h <= maxGoals; h++) {
    const ph = goalsDistH[h];
    if (ph === 0) continue;
    for (let a = 0; a <= maxGoals; a++) {
      const joint = ph * goalsDistA[a];
      if (h > a) pWinHome += joint;
      else if (h === a) pDraw += joint;
      else pWinAway += joint;
    }
  }
  return { pWinHome, pDraw, pWinAway, goalsDistH, goalsDistA };
}

// Given a total, find the supremacy (xGH - xGA) that reproduces the market's
// split of the two DECISIVE outcomes. Conditioning on "not a draw" is what
// keeps the known Poisson draw bias out of the fitted goal means.
//
// The home share is strictly increasing in supremacy at a fixed total, so this
// is another safe bisection.
export function supremacyFromMatchOdds(totalGoals, pHome, pAway, opts = {}) {
  const maxGoals = opts.maxGoals ?? MAX_GOALS;
  const decisive = pHome + pAway;
  if (!(decisive > 0)) throw new Error('odds: a market with no decisive probability cannot be inverted');
  const targetShare = pHome / decisive;

  const shareAt = (s) => {
    const p = outcomeProbs((totalGoals + s) / 2, (totalGoals - s) / 2, maxGoals);
    const d = p.pWinHome + p.pWinAway;
    return d > 0 ? p.pWinHome / d : 0.5;
  };

  // Both means must stay positive, so supremacy is bounded by the total.
  let lo = -totalGoals * (1 - 1e-9);
  let hi = totalGoals * (1 - 1e-9);
  for (let i = 0; i < ODDS_PARAMS.solverIterations; i++) {
    const mid = (lo + hi) / 2;
    if (shareAt(mid) < targetShare) lo = mid;
    else hi = mid;
    if (hi - lo < ODDS_PARAMS.solverTolerance) break;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Normalized market probabilities -> the quantities fixtures.js produces
// ---------------------------------------------------------------------------

export function deriveFromOdds(normalized, opts = {}) {
  const maxGoals = opts.maxGoals ?? MAX_GOALS;
  const fallbackTotalGoals = opts.fallbackTotalGoals ?? ODDS_PARAMS.fallbackTotalGoals;

  if (!normalized || typeof normalized !== 'object') {
    throw new Error('odds: deriveFromOdds needs a normalized fixture odds object');
  }
  const { pHome, pDraw, pAway } = normalized;
  for (const [label, v] of [['pHome', pHome], ['pDraw', pDraw], ['pAway', pAway]]) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`odds: ${label} must be a probability, got ${JSON.stringify(v)}`);
    }
  }

  const line = chooseTotalsLine(normalized.totals);
  let totalGoals;
  let totalsSource;
  if (line) {
    totalGoals = totalGoalsFromOverUnder(line.line, line.pOver, opts);
    totalsSource = 'market';
  } else {
    // No goal-environment market. The 1X2 prices alone cannot separate a tight
    // 1-0 game from an open 3-2, so the total has to come from somewhere else
    // and the caller is told which fixtures leaned on it.
    totalGoals = fallbackTotalGoals;
    totalsSource = 'fallback';
  }

  const supremacy = supremacyFromMatchOdds(totalGoals, pHome, pAway, { maxGoals });
  const xGH = (totalGoals + supremacy) / 2;
  const xGA = (totalGoals - supremacy) / 2;
  const model = outcomeProbs(xGH, xGA, maxGoals);

  return {
    // The projectFixture contract, key for key.
    xGH,
    xGA,
    pCSHome: model.goalsDistA[0],
    pCSAway: model.goalsDistH[0],
    pWinHome: model.pWinHome,
    pDraw: model.pDraw,
    pWinAway: model.pWinAway,
    goalsDistH: model.goalsDistH,
    goalsDistA: model.goalsDistA,
    // Odds-specific extras. Nothing in the fixture contract reads these; they
    // exist for the evaluation and for the model-status panel.
    totalGoals,
    supremacy,
    totalsSource,
    // How far the fitted Poisson draw is from the market's draw. Independent
    // Poisson understates draws, so this is expected to be negative on tight
    // fixtures; a large magnitude means this fixture is a poor Poisson fit and
    // its derived clean-sheet numbers deserve less trust.
    drawResidual: model.pDraw - pDraw,
    source: normalized.source,
    fetchedAt: normalized.fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// The adapter interface
//
// A vendor module is an object with four members. Networking is deliberately
// NOT one of them: `buildRequest` and `parse` are pure, so an adapter can be
// tested against a saved payload with no key, no network and no clock, which is
// the only reason the unverified adapter below can be reviewed at all.
//
//   name        string, and it lands in `source` on every row it produces
//   describe()  what the adapter can actually fetch, for the model-status panel
//   buildRequest(params) -> { url, headers }
//   parse(payload, ctx)  -> NormalizedFixtureOdds[]
//
// `ctx` must carry `resolveTeam(name) -> teamId`. Team-name matching is the one
// genuinely hard part of any odds integration (bookmakers write "Wolverhampton
// Wanderers", FPL writes "Wolves") and it is pushed onto the caller on purpose:
// this module has no business owning a name table, and a wrong silent match
// would corrupt a projection invisibly. `parse` throws on an unresolved name.
// ---------------------------------------------------------------------------

export function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('odds: adapter must be an object');
  if (!adapter.name || typeof adapter.name !== 'string') throw new Error('odds: adapter needs a name');
  for (const method of ['describe', 'buildRequest', 'parse']) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`odds: adapter ${adapter.name} is missing ${method}()`);
    }
  }
  return adapter;
}

// The generic runner. Injected fetch, so this module never reaches the network
// on its own and a test can drive it with a stub.
export async function loadOdds(adapter, params, ctx = {}) {
  assertAdapter(adapter);
  if (typeof ctx.resolveTeam !== 'function') {
    throw new Error('odds: loadOdds needs ctx.resolveTeam(name) to map bookmaker team names onto FPL team ids');
  }
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('odds: no fetch implementation available');

  const { url, headers } = adapter.buildRequest(params);
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`odds: ${adapter.name} returned HTTP ${res.status}`);
  const payload = await res.json();
  return adapter.parse(payload, ctx);
}

// ---------------------------------------------------------------------------
// Worked adapter: The Odds API (the-odds-api.com), v4.
//
// UNVERIFIED. Written against the published v4 schema and NEVER run against the
// live service, because no key exists. Treat every field name below as a claim
// to be checked on the first real response, not as a fact. The shapes it
// assumes:
//
//   live       GET /v4/sports/{sport}/odds?apiKey&regions&markets&oddsFormat
//              -> [ { id, commence_time, home_team, away_team,
//                     bookmakers: [ { key, title, last_update,
//                       markets: [ { key: 'h2h',    outcomes: [ {name, price} ] },
//                                  { key: 'totals', outcomes: [ {name: 'Over'|'Under', price, point} ] } ] } ] } ]
//
//   historical GET /v4/historical/sports/{sport}/odds?...&date=<ISO>
//              -> { timestamp, previous_timestamp, next_timestamp, data: [ ...as above... ] }
//
// The historical wrapper is the important one: `timestamp` is the moment the
// snapshot was actually taken, which is what belongs in `fetchedAt`, NOT the
// requested date and not now(). The evaluation plan's leakage check reads that
// field, so getting it from the wrapper rather than the request is the
// difference between a valid backtest and a worthless one.
//
// CONSENSUS. Each bookmaker's book is de-margined ON ITS OWN and the resulting
// probabilities are averaged. Averaging raw decimal odds across books instead
// would be wrong twice over: the arithmetic mean of decimal odds is biased
// upward (odds are reciprocals of the quantity being averaged), and the
// resulting synthetic book carries a margin belonging to no actual bookmaker.
// ---------------------------------------------------------------------------

export const THE_ODDS_API_SPORT_KEY = 'soccer_epl';

export function theOddsApiAdapter({
  apiKey,
  sport = THE_ODDS_API_SPORT_KEY,
  regions = 'uk',
  markets = 'h2h,totals',
  bookmakers = null,
  baseUrl = 'https://api.the-odds-api.com',
  marginMethod = ODDS_PARAMS.marginMethod,
} = {}) {
  return {
    name: 'the-odds-api',

    describe() {
      return {
        provider: 'The Odds API v4',
        docs: 'https://the-odds-api.com/liveapi/guides/v4/',
        sport,
        regions,
        markets: markets.split(','),
        historical: true,
        // Quota arithmetic, from the published rules: a live request costs
        // markets x regions credits, a historical one costs 10 x markets x
        // regions. Stated here so a caller can budget before it spends.
        creditsPerLiveRequest: markets.split(',').length * regions.split(',').length,
        creditsPerHistoricalRequest: 10 * markets.split(',').length * regions.split(',').length,
        verified: false,
      };
    },

    // `at` is an ISO timestamp. Passing it switches to the historical endpoint,
    // which returns the last snapshot at or before that moment: exactly the
    // "what did the market say at the deadline" question a backtest asks.
    buildRequest({ at = null } = {}) {
      if (!apiKey) throw new Error('odds: the-odds-api adapter needs an apiKey');
      const path = at
        ? `/v4/historical/sports/${encodeURIComponent(sport)}/odds`
        : `/v4/sports/${encodeURIComponent(sport)}/odds`;
      const qs = new URLSearchParams({
        apiKey,
        regions,
        markets,
        oddsFormat: 'decimal',
        dateFormat: 'iso',
      });
      if (bookmakers) qs.set('bookmakers', bookmakers);
      if (at) qs.set('date', at);
      return { url: `${baseUrl}${path}?${qs.toString()}`, headers: { accept: 'application/json' } };
    },

    parse(payload, ctx = {}) {
      if (typeof ctx.resolveTeam !== 'function') {
        throw new Error('odds: the-odds-api parse needs ctx.resolveTeam(name)');
      }
      // A historical response wraps the event array; a live one is the array.
      const isHistorical = payload && !Array.isArray(payload) && Array.isArray(payload.data);
      const events = isHistorical ? payload.data : payload;
      if (!Array.isArray(events)) throw new Error('odds: the-odds-api payload was neither an event array nor a historical wrapper');

      const snapshotAt = isHistorical ? payload.timestamp : (ctx.fetchedAt || null);
      if (!snapshotAt) {
        throw new Error('odds: no snapshot timestamp; pass ctx.fetchedAt for a live payload');
      }

      const out = [];
      for (const ev of events) {
        const homeTeamId = resolveOrThrow(ctx.resolveTeam, ev.home_team);
        const awayTeamId = resolveOrThrow(ctx.resolveTeam, ev.away_team);

        const h2hProbs = [];
        const totalsByLine = new Map();

        for (const book of ev.bookmakers || []) {
          for (const market of book.markets || []) {
            if (market.key === 'h2h' || market.key === 'h2h_3_way') {
              const price = (label) => {
                const o = (market.outcomes || []).find(x => x.name === label);
                return o ? o.price : null;
              };
              const home = price(ev.home_team);
              const away = price(ev.away_team);
              const draw = price('Draw');
              // A two-way h2h (no draw quoted) is a different market and is
              // skipped rather than guessed at.
              if (home && draw && away) {
                h2hProbs.push(impliedProbabilities([home, draw, away], { method: marginMethod }).probs);
              }
            } else if (market.key === 'totals') {
              const byPoint = new Map();
              for (const o of market.outcomes || []) {
                if (typeof o.point !== 'number') continue;
                if (!byPoint.has(o.point)) byPoint.set(o.point, {});
                byPoint.get(o.point)[o.name] = o.price;
              }
              for (const [point, pair] of byPoint) {
                if (!pair.Over || !pair.Under) continue;
                // Integer lines carry a push and this module refuses them, so
                // they are dropped here rather than thrown on: one book quoting
                // a 3.0 line must not kill a whole gameweek's parse.
                if (Math.round(point * 2) % 2 === 0) continue;
                const probs = impliedProbabilities([pair.Over, pair.Under], { method: marginMethod }).probs;
                if (!totalsByLine.has(point)) totalsByLine.set(point, []);
                totalsByLine.get(point).push(probs);
              }
            }
          }
        }

        if (h2hProbs.length === 0) continue;

        const consensus = averageProbabilities(h2hProbs);
        const totals = [...totalsByLine.entries()].map(([line, rows]) => {
          const avg = averageProbabilities(rows);
          return { line, pOver: avg[0], pUnder: avg[1], overround: 0, bookmakerCount: rows.length };
        }).sort((a, b) => a.line - b.line);

        out.push({
          source: 'the-odds-api',
          fetchedAt: snapshotAt,
          fixtureId: ev.id ?? null,
          homeTeamId,
          awayTeamId,
          commenceTime: ev.commence_time ?? null,
          pHome: consensus[0],
          pDraw: consensus[1],
          pAway: consensus[2],
          // Each book was de-margined individually, so the consensus itself has
          // no overround left to report.
          overround: 0,
          marginMethod,
          bookmakerCount: h2hProbs.length,
          totals,
        });
      }
      return out;
    },
  };
}

function resolveOrThrow(resolveTeam, name) {
  const id = resolveTeam(name);
  if (id === null || id === undefined) {
    throw new Error(`odds: could not map bookmaker team name "${name}" onto an FPL team id`);
  }
  return id;
}

// Mean of several already-de-margined probability vectors, renormalized. The
// renormalization is a formality (a mean of unit-sum vectors already sums to 1)
// and it is here so floating point cannot leak a 1e-16 drift downstream.
export function averageProbabilities(rows) {
  if (!rows.length) throw new Error('odds: cannot average an empty set of probabilities');
  const n = rows[0].length;
  const acc = new Array(n).fill(0);
  for (const row of rows) {
    if (row.length !== n) throw new Error('odds: cannot average probability vectors of different lengths');
    for (let i = 0; i < n; i++) acc[i] += row[i];
  }
  const total = sum(acc);
  return acc.map(v => v / total);
}
