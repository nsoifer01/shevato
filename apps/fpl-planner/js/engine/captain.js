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
//    captain's fixture. A postponement, an abandoned match, a rested spine or a
//    blank takes both, so the fallback term is discounted by
//    SAME_CLUB_CORRELATION when the two share a club.
//
// On top of the certainty equivalent sit three small, explicitly-labelled
// tilts: penalty and set-piece duty, fixture difficulty, and model confidence.
// They are deliberately small because the projection already contains the
// primary effect of all three; their job is to break ties and to separate a
// nailed penalty taker from an identical player without the ball.
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

// How much of a same-club vice's value survives the captain not playing. Half:
// some of the ways a captain misses a gameweek (a late knock, a rotation) leave
// his team mate playing, and some (postponement, abandonment, a blank) do not.
const SAME_CLUB_CORRELATION = 0.5;

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

// A projection built on a handful of minutes is not the same bet as one built
// on three seasons, even at the same mean.
const CONFIDENCE_PENALTY = { high: 0, medium: 0.15, low: 0.45 };

export const CAPTAIN_PARAMS = Object.freeze({
  riskProfiles: RISK_PROFILES,
  minCaptainPAppear: MIN_CAPTAIN_PAPPEAR,
  minVicePAppear: MIN_VICE_PAPPEAR,
  sameClubCorrelation: SAME_CLUB_CORRELATION,
  penaltyDutyBonus: PENALTY_DUTY_BONUS,
  setPieceDutyBonus: SET_PIECE_DUTY_BONUS,
  fixtureWeight: FIXTURE_WEIGHT,
  neutralFdr: NEUTRAL_FDR,
  confidencePenalty: CONFIDENCE_PENALTY,
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

function buildCandidate(playerId, proj, player, weights) {
  const xPoints = proj ? proj.xPoints : 0;
  const ceiling = proj ? proj.ceiling : 0;
  const sd = proj ? proj.sd : 0;
  const pAppear = proj ? proj.pAppear : 0;
  const confidence = (proj && proj.confidence) || 'low';

  const certaintyEquivalent = weights.meanWeight * xPoints + weights.upsideWeight * ceiling;
  const duty = dutyBonus(player);
  const fixture = fixtureBonus(proj);
  const confidencePenalty = CONFIDENCE_PENALTY[confidence] ?? CONFIDENCE_PENALTY.low;

  const value = certaintyEquivalent + duty.penalties + duty.setPieces + fixture - confidencePenalty;

  return {
    playerId,
    teamId: player ? player.teamId : null,
    xPoints,
    ceiling,
    sd,
    pAppear,
    confidence,
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
  return vice.teamId === captain.teamId ? 1 - SAME_CLUB_CORRELATION : 1;
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
