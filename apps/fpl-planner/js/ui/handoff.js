// The handoff to Fantasy Premier League: turning a plan into a payload the
// bookmarklet can apply, and reading one back.
//
// WHY A HANDOFF AND NOT A BUTTON THAT POSTS FROM HERE: FPL's write endpoints
// need the manager's own login. This app has no account, sends no credentials,
// and its proxy is a read-only allowlist (netlify/functions/fpl.mjs), so it
// cannot submit anything and is not going to start holding a password so it
// can. What it can do is hand the decision over in a form the user carries to
// FPL themselves: the app writes the payload, the user's own browser (already
// signed in to FPL) submits it from bookmarklet/fpl-transfer.js.
//
// WHAT THE PAYLOAD CARRIES (v2): the WHOLE plan, not just its transfers. The
// transfers, the chip, the eleven, the bench in auto-sub order, the captain and
// the vice. v1 carried transfers only, which left the user to reproduce the
// lineup, the armband and half the chips by hand - the part of the plan that
// changes every single gameweek, including the weeks where the advice is to
// make no transfer at all. A plan that can only be applied in the weeks it
// spends money is a plan that cannot be applied in most weeks.
//
// This module is pure and has no DOM access, so both sides of that contract are
// testable. The bookmarklet carries its OWN copy of the decoder because it has
// to run standalone on fantasy.premierleague.com with nothing imported;
// tests/bookmarklet.test.mjs pins that copy against this one by round-tripping
// what encodeHandoff() produces through the shipped bookmarklet bytes.
//
// WHAT THE PAYLOAD DELIBERATELY DOES NOT CARRY: prices, names, positions, or
// the count of free transfers. Every one of those is available to the
// bookmarklet from FPL itself, authenticated, at the moment of submission, and
// FPL's copy is the one that binds. A price this app reconstructed (README,
// "selling prices") would be a second opinion arriving as an instruction, and a
// POSITION this app assigned would be the same mistake: which slot a player
// occupies is derived on the FPL side from FPL's own element types. Ids, a
// gameweek and two chip slots are the whole of it, which is also what keeps the
// pasted text short enough to read.

export const PAYLOAD_VERSION = 2;

// The two chips the transfers endpoint itself accepts: playing either one IS
// the act of transferring, so it travels with the transfers.
export const SUBMITTABLE_CHIPS = ['wildcard', 'freehit'];

// The two that are played by saving your team instead, on the other endpoint.
// They travel in the team half of the payload for that reason, not because they
// are lesser: a Bench Boost or a Triple Captain is submitted as part of the
// picks, exactly as FPL's own team page does it.
export const SELECTION_CHIPS = ['bboost', '3xc'];

export const XI_SIZE = 11;
export const BENCH_SIZE = 4;
export const SQUAD_SIZE = XI_SIZE + BENCH_SIZE;

const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

// Which endpoint a chip is played on. Anything unrecognised is sent NOWHERE and
// reported back as deferred: an unknown chip name is a chip this code has never
// been tested against, and guessing which endpoint it belongs to is how you
// spend someone's Triple Captain in a Bench Boost week.
export function chipRouting(chip) {
  if (!chip) return { transfers: null, team: null, deferred: null };
  if (SUBMITTABLE_CHIPS.includes(chip)) return { transfers: chip, team: null, deferred: null };
  if (SELECTION_CHIPS.includes(chip)) return { transfers: null, team: chip, deferred: null };
  return { transfers: null, team: null, deferred: chip };
}

// The bench as the four ids FPL orders them in: the reserve keeper first,
// then the outfield substitutes in the order the engine wants them to come on.
export function benchOrder(plan) {
  const bench = (plan && plan.bench) || {};
  const order = Array.isArray(bench.order) ? bench.order : [];
  return bench.gk ? [bench.gk, ...order] : order.slice();
}

// A plan plus a team id -> the payload, or a refusal in the caller's words.
//
// `isDraft` is the pre-season squad builder: it produces a real plan over a
// squad that does not exist on FPL yet, so there is nothing to apply it to.
export function buildHandoff({ plan, teamId, isDraft = false }) {
  if (!plan) return { ok: false, reason: 'There is no plan to hand over yet.' };
  if (isDraft) {
    return { ok: false, reason: 'This is a pre-season draft, so there is no Fantasy Premier League squad to apply it to yet.' };
  }

  const entry = Number(teamId);
  if (!isPositiveInt(entry)) {
    return { ok: false, reason: 'This plan is not tied to a Fantasy Premier League team ID.' };
  }
  if (!isPositiveInt(plan.gw)) {
    return { ok: false, reason: 'This plan is not tied to a gameweek.' };
  }

  const xi = Array.isArray(plan.startingXI) ? plan.startingXI.slice() : [];
  const bench = benchOrder(plan);
  if (xi.length !== XI_SIZE || bench.length !== BENCH_SIZE) {
    return { ok: false, reason: 'This plan does not name a full eleven and bench, so there is no team to set.' };
  }

  const outs = Array.isArray(plan.transfersOut) ? plan.transfersOut : [];
  const ins = Array.isArray(plan.transfersIn) ? plan.transfersIn : [];
  if (outs.length !== ins.length) {
    return { ok: false, reason: 'This plan has a transfer with a missing player.' };
  }

  const routing = chipRouting(plan.chip);
  const payload = {
    v: PAYLOAD_VERSION,
    entry,
    event: plan.gw,
    chip: routing.transfers,
    transfers: outs.map((out, i) => ({ out, in: ins[i] })),
    team: {
      xi,
      bench,
      captain: plan.captain,
      vice: plan.viceCaptain,
      chip: routing.team,
    },
  };

  // Round-trip before handing it out: the encoder and the decoder disagreeing
  // is a defect the user would otherwise meet as a paste that does not work.
  const check = decodeHandoff(encodeHandoff(payload));
  if (!check.ok) return { ok: false, reason: check.reason };

  return { ok: true, payload, deferredChip: routing.deferred };
}

// Compact JSON, not base64. The user is about to paste this into a page that
// will spend their transfers with it, so it stays legible: ids they can check
// against the card above it, and no encoding to hide behind.
export function encodeHandoff(payload) {
  return JSON.stringify(payload);
}

// Strict, and the same rules the bookmarklet applies. Every refusal names what
// is wrong rather than returning a blanket "invalid", because the likeliest
// cause is a partial copy and the user needs to know that is what happened.
export function decodeHandoff(text) {
  const raw = String(text === null || text === undefined ? '' : text).trim();
  if (!raw) return { ok: false, reason: 'Nothing was pasted.' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'That is not a plan from the FPL Planner. Copy it again with the Copy plan button.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'That is not a plan from the FPL Planner.' };
  }
  if (parsed.v !== PAYLOAD_VERSION) {
    return { ok: false, reason: `This plan is version ${parsed.v}, and this bookmarklet reads version ${PAYLOAD_VERSION}. Install the current bookmarklet from the planner.` };
  }
  if (!isPositiveInt(parsed.entry)) {
    return { ok: false, reason: 'That plan carries no Fantasy Premier League team ID.' };
  }
  // The gameweek is only bounded as a positive integer here. Whether it is the
  // RIGHT gameweek is not a question this text can answer: the bookmarklet
  // checks it against the event FPL itself calls next.
  if (!isPositiveInt(parsed.event)) {
    return { ok: false, reason: 'That plan carries no gameweek.' };
  }
  if (parsed.chip !== null && parsed.chip !== undefined && !SUBMITTABLE_CHIPS.includes(parsed.chip)) {
    return { ok: false, reason: `A ${parsed.chip} is not played by making transfers, so it cannot travel with them.` };
  }
  // A plan with no transfers is ordinary: rolling a transfer is advice, and the
  // eleven still has to be set. An ABSENT transfers list is not.
  if (!Array.isArray(parsed.transfers)) {
    return { ok: false, reason: 'That plan lists no transfers.' };
  }

  const transfers = [];
  const seenOut = new Set();
  const seenIn = new Set();
  for (const row of parsed.transfers) {
    if (!row || typeof row !== 'object') return { ok: false, reason: 'That plan has a transfer that is not a pair of players.' };
    const out = row.out;
    const into = row.in;
    if (!isPositiveInt(out) || !isPositiveInt(into)) {
      return { ok: false, reason: 'That plan has a transfer with a missing player.' };
    }
    if (out === into) return { ok: false, reason: 'That plan transfers a player for himself.' };
    if (seenOut.has(out) || seenIn.has(into)) {
      return { ok: false, reason: 'That plan names the same player twice.' };
    }
    seenOut.add(out);
    seenIn.add(into);
    transfers.push({ out, in: into });
  }
  // A player leaving and arriving in the same move is not a transfer FPL can
  // apply, and it is what a hand-edited payload tends to produce.
  for (const id of seenOut) {
    if (seenIn.has(id)) return { ok: false, reason: 'That plan sells and buys the same player.' };
  }

  const team = decodeTeam(parsed.team);
  if (!team.ok) return team;

  // The two halves have to describe ONE plan. Everything bought must end up in
  // the fifteen and everything sold must be gone from it, or the payload is
  // asking for a squad it does not itself believe in.
  const squad = new Set([...team.value.xi, ...team.value.bench]);
  for (const row of transfers) {
    if (!squad.has(row.in)) {
      return { ok: false, reason: 'That plan buys a player it then leaves out of the fifteen.' };
    }
    if (squad.has(row.out)) {
      return { ok: false, reason: 'That plan sells a player it then keeps in the fifteen.' };
    }
  }

  return {
    ok: true,
    payload: {
      v: PAYLOAD_VERSION,
      entry: parsed.entry,
      event: parsed.event,
      chip: parsed.chip || null,
      transfers,
      team: team.value,
    },
  };
}

// The team half: eleven, four, an armband on two of the eleven, and at most one
// of the chips that are played by saving a team. Positions are NOT here on
// purpose (see the header): which slot each of these ids occupies is worked out
// on the FPL side from FPL's own element types.
function decodeTeam(team) {
  if (!team || typeof team !== 'object' || Array.isArray(team)) {
    return { ok: false, reason: 'That plan carries no team to set. Copy it again from the planner.' };
  }

  const xi = team.xi;
  const bench = team.bench;
  if (!Array.isArray(xi) || xi.length !== XI_SIZE) {
    return { ok: false, reason: `That plan names ${Array.isArray(xi) ? xi.length : 'no'} starters, and a Fantasy Premier League team starts ${XI_SIZE}.` };
  }
  if (!Array.isArray(bench) || bench.length !== BENCH_SIZE) {
    return { ok: false, reason: `That plan names ${Array.isArray(bench) ? bench.length : 'no'} substitutes, and a Fantasy Premier League bench holds ${BENCH_SIZE}.` };
  }

  const seen = new Set();
  for (const id of [...xi, ...bench]) {
    if (!isPositiveInt(id)) return { ok: false, reason: 'That plan has a squad place with no player in it.' };
    if (seen.has(id)) return { ok: false, reason: 'That plan puts the same player in two squad places.' };
    seen.add(id);
  }

  const captain = team.captain;
  const vice = team.vice;
  if (!isPositiveInt(captain) || !isPositiveInt(vice)) {
    return { ok: false, reason: 'That plan carries no captain and vice-captain.' };
  }
  if (captain === vice) {
    return { ok: false, reason: 'That plan makes the same player captain and vice-captain.' };
  }
  // Both armbands on the pitch. FPL allows a captain on the bench and simply
  // wastes him; the planner never picks one, so a payload that does is corrupt.
  const starters = new Set(xi);
  if (!starters.has(captain) || !starters.has(vice)) {
    return { ok: false, reason: 'That plan puts the captain or vice-captain on the bench.' };
  }

  if (team.chip !== null && team.chip !== undefined && !SELECTION_CHIPS.includes(team.chip)) {
    return { ok: false, reason: `A ${team.chip} is not played by saving your team, so it cannot travel with one.` };
  }

  return {
    ok: true,
    value: {
      xi: xi.slice(),
      bench: bench.slice(),
      captain,
      vice,
      chip: team.chip || null,
    },
  };
}
