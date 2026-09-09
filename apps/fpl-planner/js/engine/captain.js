// Captain and vice-captain.
//
// The armband is worth roughly a fifth of a season, and it is the one decision
// in FPL that is explicitly a risk decision rather than an expectation one.
// A pure expected-value maximizer always hands it to the highest projected
// scorer, because doubling is a monotone transform of the mean. That is the
// wrong objective for three reasons this module models directly.
//
// 1. UPSIDE IS THE POINT. Captaincy is where a manager buys variance: a
//    doubled haul is what moves rank, and a doubled six is what everybody else
//    already has. So the objective is a certainty equivalent that mixes the
//    mean with the 85th-percentile ceiling the projection carries,
//
//      ce = meanWeight * xPoints + upsideWeight * ceiling
//
//    with the split set by the risk profile. Both numbers come out of the
//    composed point distribution in projections.js, so neither is invented.
//
// 2. THE ARMBAND CAN BE WASTED. If the captain plays no minutes the vice takes
//    over, so the pair has a joint value:
//
//      E[armband] = ce(captain) + P(captain does not play) * ce(vice)
//
//    The captain and the vice are therefore chosen TOGETHER, over pairs, which
//    is what lets a slightly lower-ceiling captain win when he comes with a
//    much safer fallback.
//
// 3. THE FALLBACK CAN FAIL WITH HIM. A vice at the same club shares the
//    captain's fixture, so the fallback term is discounted when the two share a
//    club. The size of that discount is MEASURED, not assumed: see
//    SAME_CLUB_FALLBACK_RETENTION. It is about one percent, not the half this
//    module asserted until 2026-09-09.
//
// On top of the certainty equivalent sit four small, explicitly-labelled tilts:
// penalty duty, set-piece duty, fixture difficulty, and model confidence. They
// are small because the projection already contains the primary effect of all
// four; their job is to break ties and to separate a nailed penalty taker from
// an identical player without the ball. They are summed and then bounded
// TOGETHER through MAX_TILT, because until 2026-09-09 they were not bounded at
// all and four heuristics stacking in the same direction could overturn nearly
// two points of projection between them.
//
// And a hard floor: a player below MIN_CAPTAIN_PAPPEAR is never captained, no
// matter how good the ceiling looks, because a captain who does not play costs
// the armband and there is no recovering it.

const RISK_PROFILES = {
  conservative: { meanWeight: 0.90, upsideWeight: 0.10 },
  balanced: { meanWeight: 0.75, upsideWeight: 0.25 },
  aggressive: { meanWeight: 0.50, upsideWeight: 0.50 },
};

// Minutes floors. A captain is a bet that a player is on the pitch; below a
// coin flip that bet is not worth making. The vice floor is lower because the
// vice only has to be better than nothing.
const MIN_CAPTAIN_PAPPEAR = 0.5;
const MIN_VICE_PAPPEAR = 0.35;

// How much of a same-club vice's value survives the captain not playing.
//
// THIS WAS 0.5, AND AS A PENALTY THAT IS WRONG BY ABOUT FIFTY TIMES. The
// number is a
// conditional appearance probability written as a ratio,
//
//   P(vice appears | captain did not) / P(vice appears)
//
// and that ratio is directly measurable in the four season archives this repo
// already holds. Over 153,158 same-club pairs of nailed players (10+ gameweeks,
// 60%+ start rate), pooled across 2022-23 to 2025-26:
//
//   P(team mate appears)                      0.8830
//   P(team mate appears | the other was out)  0.8701   ratio 0.9854
//
// and the different-club control over 3,110,050 pairs reads 0.8825 / 0.8779,
// ratio 0.9947, which is the league-wide common cause (congested rounds rotate
// everybody a little). Dividing one by the other leaves the effect that is
// genuinely ABOUT sharing a club: **0.9906**, a one percent penalty. Every
// season agrees: 0.984, 0.991, 0.994, 0.977.
//
// The intuition behind 0.5 was not wrong, only its size. A captain misses a
// gameweek far more often for reasons private to him (a knock in the warm-up,
// rotation, a suspension, illness) than for reasons that take his whole club
// with him, and the appearance record says the private reasons dominate by two
// orders of magnitude.
//
// What the archive CANNOT see is a fixture that never happened: a postponement
// or abandonment removes both players' rows entirely, so those pairs are absent
// from the sample above rather than counted as a joint failure. Bounding it:
// 53 of 3,000 team-gameweeks inside an otherwise-full round carried no fixture,
// 1.77%, and that is an upper bound because most of them are scheduled blanks
// the projection has already priced through pAppear.
//
// So the retained fraction is 0.9906 x (1 - 0.0177) = 0.973 as measured, and it
// is set at 0.95 rather than 0.973 to leave room for the squad-wide events the
// appearance record books against individuals: an illness sweep, a spine rested
// before a European tie, a manager sacked mid-week.
const SAME_CLUB_FALLBACK_RETENTION = 0.95;

// Duty tilts by order of preference. Penalties matter most because a penalty
// converts a fixture into a near-certain shot, which is a ceiling event.
const PENALTY_DUTY_BONUS = [0.25, 0.10, 0.03];
const SET_PIECE_DUTY_BONUS = [0.10, 0.04, 0.01];

// Fixture tilt. FDR is the only strength signal FPL publishes that reflects
// things the Poisson model cannot see, so an easy fixture is worth a small
// nudge on top of the expected goals it already produced. 3 is the neutral
// difficulty on FPL's 1-5 scale.
const FIXTURE_WEIGHT = 0.15;
const NEUTRAL_FDR = 3;

// THE TILTS ARE A TIE-BREAK AND ARE NOW BOUNDED LIKE ONE.
//
// Penalty duty, set-piece duty, fixture and confidence are all corrections to a
// projection that already contains the primary effect of each. Unbounded they
// summed to a span of 1.4 points (+0.65 for a nailed penalty taker on the
// easiest fixture, -0.75 for an unknown on the hardest), and at a mean weight of
// 0.75 that is enough to overturn a 1.87-point projection gap. Four heuristics
// quietly outvoting the model is not a tie-break, and the module header already
// claimed they were "deliberately small" while the arithmetic said otherwise.
//
// The sum is squashed through tanh, which saturates smoothly at the bound so
// there is no edge for a candidate to sit on. It leaves a genuine tie-break
// almost untouched and bites hardest exactly where the old behaviour was worst:
// a 0.05 tilt is shrunk by 0.6%, 0.10 by 2.3%, 0.15 by 5.0%, but 0.40 by 26%
// and the old 0.65 maximum by 46%. The bound is half a projected point of
// authority: MAX_TILT / meanWeight = 0.375 / 0.75 = 0.5 xP. Below that gap the
// tilts may decide the armband; above it they may not.
const MAX_TILT = 0.375;

export function boundedTilt(raw, max = MAX_TILT) {
  if (!Number.isFinite(raw)) return 0;
  if (!(max > 0)) return 0;
  return max * Math.tanh(raw / max);
}

// A projection built on a handful of minutes is not the same bet as one built
// on three seasons, even at the same mean.
//
// This used to be a lookup on the confidence TIER, which made it a cliff: two
// players a single minute either side of a threshold were charged 0.30 points
// apart, and at gameweek 4 the thresholds put almost the whole pool on one side
// of that cliff for reasons that had nothing to do with sample size (see the
// long note in minutes.js). It is now a linear reading of the continuous
// confidence score, so the charge moves with the evidence instead of with a
// bucket edge, and the tier is left to the UI.
const CONFIDENCE_MAX_PENALTY = 0.45;

// Fallback for a projection row that predates `confidenceScore` (the backtest's
// perfect-foresight oracle builds rows by hand). Tier midpoints, so the old
// behaviour is recovered rather than approximated.
const TIER_SCORE = { high: 1, medium: 0.5, low: 0 };

export const CAPTAIN_PARAMS = Object.freeze({
  riskProfiles: RISK_PROFILES,
  minCaptainPAppear: MIN_CAPTAIN_PAPPEAR,
  minVicePAppear: MIN_VICE_PAPPEAR,
  sameClubFallbackRetention: SAME_CLUB_FALLBACK_RETENTION,
  penaltyDutyBonus: PENALTY_DUTY_BONUS,
  setPieceDutyBonus: SET_PIECE_DUTY_BONUS,
  fixtureWeight: FIXTURE_WEIGHT,
  neutralFdr: NEUTRAL_FDR,
  confidenceMaxPenalty: CONFIDENCE_MAX_PENALTY,
  maxTilt: MAX_TILT,
});

function dutyBonus(player) {
  if (!player || !player.setPieces) return { penalties: 0, setPieces: 0 };
  const pick = (order, table) => {
    if (order === null || order === undefined) return 0;
    const i = Math.round(order) - 1;
    return i >= 0 && i < table.length ? table[i] : 0;
  };
  const penalties = pick(player.setPieces.penaltiesOrder, PENALTY_DUTY_BONUS);
  const setPieces = Math.max(
    pick(player.setPieces.directFreekicksOrder, SET_PIECE_DUTY_BONUS),
    pick(player.setPieces.cornersOrder, SET_PIECE_DUTY_BONUS),
  );
  return { penalties, setPieces };
}

function fixtureBonus(proj) {
  const fixtures = (proj && proj.fixtures) || [];
  if (!fixtures.length) return 0;
  let sum = 0;
  let n = 0;
  for (const f of fixtures) {
    if (typeof f.fdr === 'number') {
      sum += f.fdr;
      n += 1;
    }
  }
  if (!n) return 0;
  return FIXTURE_WEIGHT * (NEUTRAL_FDR - sum / n);
}

function confidenceScoreOf(proj) {
  if (proj && Number.isFinite(proj.confidenceScore)) return Math.min(1, Math.max(0, proj.confidenceScore));
  const tier = (proj && proj.confidence) || 'low';
  return TIER_SCORE[tier] ?? 0;
}

function buildCandidate(playerId, proj, player, weights) {
  const xPoints = proj ? proj.xPoints : 0;
  const ceiling = proj ? proj.ceiling : 0;
  const sd = proj ? proj.sd : 0;
  const pAppear = proj ? proj.pAppear : 0;
  const confidence = (proj && proj.confidence) || 'low';
  const confidenceScore = confidenceScoreOf(proj);

  const certaintyEquivalent = weights.meanWeight * xPoints + weights.upsideWeight * ceiling;
  const duty = dutyBonus(player);
  const fixture = fixtureBonus(proj);
  const confidencePenalty = CONFIDENCE_MAX_PENALTY * (1 - confidenceScore);

  // The four tilts are summed and then bounded TOGETHER, so no combination of
  // them can outvote the projection by more than MAX_TILT.
  const rawTilt = duty.penalties + duty.setPieces + fixture - confidencePenalty;
  const tilt = boundedTilt(rawTilt);
  const value = certaintyEquivalent + tilt;

  return {
    playerId,
    teamId: player ? player.teamId : null,
    xPoints,
    ceiling,
    sd,
    pAppear,
    confidence,
    confidenceScore,
    value,
    eligibleCaptain: pAppear >= MIN_CAPTAIN_PAPPEAR,
    eligibleVice: pAppear >= MIN_VICE_PAPPEAR,
    components: {
      certaintyEquivalent,
      meanTerm: weights.meanWeight * xPoints,
      upsideTerm: weights.upsideWeight * ceiling,
      penaltyDuty: duty.penalties,
      setPieceDuty: duty.setPieces,
      fixture,
      confidencePenalty,
      // Both forms, because the explanation layer has to name the term that
      // moved the decision (raw) while the arithmetic has to add up (bounded).
      rawTilt,
      tilt,
    },
  };
}

// ---------------------------------------------------------------------------

export function chooseCaptain(startingXI, projections, gw, gameState, opts = {}) {
  const weights = RISK_PROFILES[opts.risk] || RISK_PROFILES.balanced;
  const players = (gameState && gameState.players) || new Map();

  const candidates = startingXI.map(id => buildCandidate(
    id,
    projections.get(id, gw),
    players.get(id),
    weights,
  ));

  // Everyone below the floor is out. If nobody clears it (a gameweek where the
  // whole eleven is doubtful, or a blank), the armband still has to go
  // somewhere, so the floor relaxes to the most likely to play and that is
  // reported rather than hidden.
  let pool = candidates.filter(c => c.eligibleCaptain);
  let floorRelaxed = false;
  if (!pool.length) {
    floorRelaxed = true;
    const bestAppear = Math.max(...candidates.map(c => c.pAppear));
    pool = candidates.filter(c => c.pAppear >= bestAppear - 1e-12);
  }

  let vicePool = candidates.filter(c => c.eligibleVice);
  if (!vicePool.length) vicePool = candidates;

  let best = null;
  for (const captain of pool) {
    const vice = bestViceFor(captain, vicePool);
    const fallbackValue = vice ? (1 - captain.pAppear) * vice.value * correlationFactor(captain, vice) : 0;
    const captainScore = captain.value + fallbackValue;
    if (best === null
      || captainScore > best.captainScore + 1e-12
      || (Math.abs(captainScore - best.captainScore) <= 1e-12 && captain.playerId < best.captain.playerId)) {
      best = { captain, vice, captainScore, fallbackValue };
    }
  }

  const captain = best.captain;
  const vice = best.vice;

  // Expected points the armband is worth: the captain's own expected points
  // again if he plays, the vice's if he does not.
  const xPointsCaptaincy = captain.xPoints
    + (vice ? (1 - captain.pAppear) * vice.xPoints * correlationFactor(captain, vice) : 0);

  // Every candidate carries a FINITE captainScore and an explicit `eligible`
  // flag. A player below the minutes floor is not a captaincy option, but the
  // explanation layer still shows his row and "-Infinity" is not a number
  // anybody can read, so ineligibility is expressed by the flag and by sorting
  // every ineligible candidate below every eligible one, never by the score.
  const ranked = candidates
    .map(c => {
      const v = bestViceFor(c, vicePool);
      const fallback = v ? (1 - c.pAppear) * v.value * correlationFactor(c, v) : 0;
      return {
        ...c,
        eligible: c.eligibleCaptain || floorRelaxed,
        captainScore: c.value + fallback,
        bestVice: v ? v.playerId : null,
      };
    })
    .sort((a, b) => (Number(b.eligible) - Number(a.eligible))
      || (b.captainScore - a.captainScore)
      || (a.playerId - b.playerId));

  return {
    captain: captain.playerId,
    viceCaptain: vice ? vice.playerId : null,
    captainScore: best.captainScore,
    xPoints: captain.xPoints,
    xPointsCaptaincy,
    ceiling: captain.ceiling,
    sd: captain.sd,
    pAppear: captain.pAppear,
    floorRelaxed,
    components: {
      ...captain.components,
      fallbackValue: best.fallbackValue,
      viceCorrelationPenalty: vice && correlationFactor(captain, vice) < 1
        ? (1 - captain.pAppear) * vice.value * (1 - correlationFactor(captain, vice))
        : 0,
      sameClubAsVice: !!(vice && vice.teamId !== null && vice.teamId === captain.teamId),
    },
    vice: vice
      ? {
        playerId: vice.playerId,
        value: vice.value,
        xPoints: vice.xPoints,
        pAppear: vice.pAppear,
        sameClub: vice.teamId !== null && vice.teamId === captain.teamId,
      }
      : null,
    candidates: ranked,
    params: { ...weights, minCaptainPAppear: MIN_CAPTAIN_PAPPEAR, minVicePAppear: MIN_VICE_PAPPEAR },
  };
}

function correlationFactor(captain, vice) {
  if (vice.teamId === null || captain.teamId === null) return 1;
  return vice.teamId === captain.teamId ? SAME_CLUB_FALLBACK_RETENTION : 1;
}

function bestViceFor(captain, vicePool) {
  let best = null;
  let bestValue = -Infinity;
  for (const c of vicePool) {
    if (c.playerId === captain.playerId) continue;
    const value = c.value * correlationFactor(captain, c);
    if (value > bestValue + 1e-12 || (Math.abs(value - bestValue) <= 1e-12 && best && c.playerId < best.playerId)) {
      bestValue = value;
      best = c;
    }
  }
  return best;
}
