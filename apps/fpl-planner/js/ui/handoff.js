// The handoff to Fantasy Premier League: turning a plan's transfers into a
// payload the bookmarklet can submit, and reading one back.
//
// WHY A HANDOFF AND NOT A BUTTON: FPL's write endpoints need the manager's own
// login. This app has no account, sends no credentials, and its proxy is a
// read-only allowlist (netlify/functions/fpl.mjs), so it cannot submit a
// transfer and is not going to start holding a password so it can. What it can
// do is hand the decision over in a form the user carries to FPL themselves:
// the app writes the payload, the user's own browser (already signed in to FPL)
// submits it from bookmarklet/fpl-transfer.js.
//
// This module is pure and has no DOM access, so both sides of that contract are
// testable. The bookmarklet carries its OWN copy of the decoder because it has
// to run standalone on fantasy.premierleague.com with nothing imported;
// tests/bookmarklet.test.mjs pins that copy against this one by round-tripping
// what encodeHandoff() produces through the shipped bookmarklet bytes.
//
// WHAT THE PAYLOAD DELIBERATELY DOES NOT CARRY: prices, names, or the count of
// free transfers. Every one of those is available to the bookmarklet from FPL
// itself, authenticated, at the moment of submission, and FPL's copy is the one
// that binds. A price this app reconstructed (README, "selling prices") would
// be a second opinion arriving as an instruction. Ids and a gameweek are the
// whole of it, which is also what keeps the pasted text short enough to read.

export const PAYLOAD_VERSION = 1;

// The two chips the transfers endpoint itself accepts: playing either one IS
// the act of transferring, so it travels with the transfers.
export const SUBMITTABLE_CHIPS = ['wildcard', 'freehit'];

// The two that are activated on the team page instead, by a different call.
// A plan can recommend one alongside ordinary transfers, so the payload records
// it as deferred rather than dropping it: the bookmarklet submits the transfers
// and tells the user the chip is still theirs to switch on.
export const SELECTION_CHIPS = ['bboost', '3xc'];

const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

// Which chip, if any, goes on the wire, and which one the user is left to play
// themselves. Anything unrecognised is treated as deferred rather than sent:
// an unknown chip name is a chip this code has never been tested against.
export function chipRouting(chip) {
  if (!chip) return { submit: null, deferred: null };
  if (SUBMITTABLE_CHIPS.includes(chip)) return { submit: chip, deferred: null };
  return { submit: null, deferred: chip };
}

// A plan plus a team id -> the payload, or a refusal in the caller's words.
export function buildHandoff({ plan, teamId }) {
  if (!plan) return { ok: false, reason: 'There is no plan to hand over yet.' };

  const entry = Number(teamId);
  if (!isPositiveInt(entry)) {
    return { ok: false, reason: 'This plan is not tied to a Fantasy Premier League team ID.' };
  }
  if (!isPositiveInt(plan.gw)) {
    return { ok: false, reason: 'This plan is not tied to a gameweek.' };
  }

  const outs = Array.isArray(plan.transfersOut) ? plan.transfersOut : [];
  const ins = Array.isArray(plan.transfersIn) ? plan.transfersIn : [];
  if (!outs.length || outs.length !== ins.length) {
    return { ok: false, reason: 'This plan makes no transfers, so there is nothing to submit.' };
  }

  const routing = chipRouting(plan.chip);
  const payload = {
    v: PAYLOAD_VERSION,
    entry,
    event: plan.gw,
    chip: routing.submit,
    transfers: outs.map((out, i) => ({ out, in: ins[i] })),
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
  if (!Array.isArray(parsed.transfers) || !parsed.transfers.length) {
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

  return {
    ok: true,
    payload: {
      v: PAYLOAD_VERSION,
      entry: parsed.entry,
      event: parsed.event,
      chip: parsed.chip || null,
      transfers,
    },
  };
}
