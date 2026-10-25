// A squad over the three-per-club limit because a player moved club
// (2026-10-24, FINDINGS ledger row 38).
//
// FPL checks the limit when a squad is picked or changed. Ten Premier League
// players moved club on 2026-09-01, after GW1's deadline, and a manager who
// held three from the club one of them joined, and has not transferred since,
// holds four: the GitHub probe's sample drew one on 2026-10-24 (Raya, Konsa,
// Zubimendi, Eze; Konsa joined Arsenal) and the planner refused to plan the squad
// at all. The rule FPL applies, restated here from FPL's rules rather than read
// from the engine:
//   - the squad held, untouched, is legal to keep, whatever its club counts;
//   - a squad any transfer produces (Wildcard and Free Hit included) holds at
//     most `squad_team_limit` from every club.
// Club counts are taken from FPL's own bootstrap (`element.team`), never from
// the engine's normalized `teamId`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan, resolveOptions } from '../js/engine/planner.js';
import { searchTransfers } from '../js/engine/transfers.js';
import { validatePlan, clubLimitBreaches } from '../js/engine/validate.js';
import { evaluateChips } from '../js/engine/chips.js';
import { whyNot } from '../js/engine/explain.js';
import { counterfactual, scoreRoute } from '../js/engine/counterfactual.js';
import { DEFAULT_SETTINGS } from '../js/ui/store.js';
import { APP_PLAN_SEED } from '../scripts/lib/probe.mjs';
import * as GW8 from './helpers/gw8-fixture.mjs';
import * as GW7 from './helpers/gw7-fixture.mjs';

const LIMIT = GW8.BOOTSTRAP.game_settings.squad_team_limit;
const OPTIONS = { horizon: DEFAULT_SETTINGS.horizon, risk: DEFAULT_SETTINGS.risk, seed: APP_PLAN_SEED };

// FPL's own club of every player, by id, from the raw bootstrap.
const fplClub = (bootstrap) => new Map(bootstrap.elements.map((e) => [e.id, e.team]));
const clubCounts = (ids, club) => {
  const n = new Map();
  for (const id of ids) n.set(club.get(id), (n.get(club.get(id)) || 0) + 1);
  return n;
};
const overLimit = (ids, club) => [...clubCounts(ids, club)].filter(([, n]) => n > LIMIT);
const sameSquad = (a, b) => a.length === b.length && new Set(a).size === new Set(b).size && a.every((id) => b.includes(id));

// The oracle: legal iff unchanged from what is held, or within the limit at every club.
const fplLegal = (squad, held, club) => sameSquad(squad, held) || overLimit(squad, club).length === 0;

const CLUB8 = fplClub(GW8.BOOTSTRAP);
const ARSENAL = GW8.BOOTSTRAP.teams.find((t) => t.short_name === 'ARS').id;
const nameOf8 = (id) => GW8.GAME_STATE.players.get(id).webName;

let bundle8 = null;
const plan8 = async () => {
  bundle8 = bundle8 || await buildPlan({ gameState: GW8.GAME_STATE, squadState: GW8.squadFor('four-arsenal'), options: OPTIONS });
  return bundle8;
};

test('the reproduced squad: four Arsenal players, held untouched since GW1, and the planner plans it', async () => {
  const squadState = GW8.squadFor('four-arsenal');
  const held = squadState.picks.map((p) => p.playerId);
  const arsenal = held.filter((id) => CLUB8.get(id) === ARSENAL).map(nameOf8).sort();
  assert.deepEqual(arsenal, ['Eze', 'Konsa', 'Raya', 'Zubimendi'], 'FPL lists four Arsenal players in the squad');
  assert.equal(GW8.ENTRIES['four-arsenal'].transfers.length, 0, 'and no transfer has ever been made: the squad is the one FPL accepted');

  const bundle = await plan8();
  for (const plan of [bundle.current, ...bundle.future]) {
    const state = plan === bundle.current ? bundle.squadState : null;
    if (plan.transferCount > 0) {
      assert.deepEqual(overLimit(plan.squad, CLUB8), [], `GW${plan.gw}: a squad after ${plan.transferCount} transfer(s) is within the limit at every club`);
    }
    if (state) assert.equal(validatePlan(plan, state, GW8.GAME_STATE, GW8.GAME_STATE.rules).ok, true);
  }
  // With five free transfers banked the plan transfers, and so brings Arsenal back to three.
  assert.ok(bundle.current.transferCount > 0);
  assert.ok(bundle.current.transfersOut.some((id) => CLUB8.get(id) === ARSENAL), 'one of the moves sells an Arsenal player');
  assert.equal(clubCounts(bundle.current.squad, CLUB8).get(ARSENAL), LIMIT);
});

test('no transfer keeps the held squad; one transfer must sell an Arsenal player; none leaves four or makes it five', () => {
  const squadState = { ...GW8.squadFor('four-arsenal'), freeTransfers: 1 };
  const held = squadState.picks.map((p) => p.playerId);
  const rules = GW8.GAME_STATE.rules;
  const cfg = resolveOptions(OPTIONS, rules, GW8.PLAN_GW);
  return plan8().then((bundle) => {
    const plans = searchTransfers({
      squadState, projections: bundle.projections, gameState: GW8.GAME_STATE, rules, horizon: cfg.horizon,
      opts: { discount: cfg.discount, maxHits: 0, maxCandidates: cfg.maxCandidates, seed: cfg.seed, ...cfg.lineupOptions },
    });
    const roll = plans.find((p) => p.transferCount === 0);
    assert.ok(roll, 'the roll is a plan: the held squad, over the limit, is legal to keep');
    assert.ok(sameSquad(roll.squad, held));
    assert.equal(validatePlan(roll, squadState, GW8.GAME_STATE, rules).ok, true);

    const moves = plans.filter((p) => p.transferCount === 1);
    assert.ok(moves.length > 0, 'a legal corrective transfer is offered');
    for (const p of moves) {
      assert.equal(CLUB8.get(p.transfersOut[0]), ARSENAL, `${nameOf8(p.transfersOut[0])} -> ${nameOf8(p.transfersIn[0])} sells an Arsenal player`);
      assert.ok(fplLegal(p.squad, held, CLUB8));
    }
  });
});

// validatePlan, the planner's last word, on hand-made squads around the boundary.
test('validatePlan judges the club limit on a changed squad only, at and around the limit', async () => {
  const bundle = await plan8();
  const squadState = bundle.squadState;
  const held = squadState.picks.map((p) => p.playerId);
  const players = GW8.GAME_STATE.players;
  const byPos = (pos, pred) => [...players.values()].filter((p) => p.position === pos && pred(p) && !held.includes(p.id)).map((p) => p.id);
  const eze = held.find((id) => nameOf8(id) === 'Eze');
  const midOut = held.find((id) => players.get(id).position === players.get(eze).position && CLUB8.get(id) !== ARSENAL && clubCounts(held, CLUB8).get(CLUB8.get(id)) < LIMIT);
  const freeClub = (id) => (clubCounts(held, CLUB8).get(CLUB8.get(id)) || 0) < LIMIT - 1;
  const midIn = byPos(players.get(eze).position, (p) => freeClub(p.id))[0];
  const arsenalMidIn = byPos(players.get(eze).position, (p) => CLUB8.get(p.id) === ARSENAL)[0];
  const clubBreach = (squad, out, inn, state = squadState) => validatePlan(
    { ...bundle.current, squad, transfersOut: out, transfersIn: inn, transferCount: out.length },
    state, GW8.GAME_STATE, GW8.GAME_STATE.rules,
  ).violations.filter((v) => v.code === 'club_limit');
  const swap = (out, inn) => held.filter((id) => !out.includes(id)).concat(inn);

  assert.deepEqual(clubBreach(held, [], []), [], 'the held squad, four Arsenal, untouched');
  const kept = clubBreach(swap([midOut], [midIn]), [midOut], [midIn]);
  assert.equal(kept.length, 1, `selling ${nameOf8(midOut)} for ${nameOf8(midIn)} keeps four Arsenal`);
  assert.equal(kept[0].detail.teamId, ARSENAL);
  assert.equal(kept[0].detail.actual, 4);
  assert.match(kept[0].message, /4 from Arsenal/);
  assert.deepEqual(clubBreach(swap([eze], [midIn]), [eze], [midIn]), [], 'selling Eze brings Arsenal back to the limit');
  const worse = clubBreach(swap([midOut], [arsenalMidIn]), [midOut], [arsenalMidIn]);
  assert.equal(worse[0].detail.actual, 5, 'buying a fifth is a breach');
  // The same squad built from nothing (no squad held) is judged in full.
  assert.equal(clubBreach(held, [], [], { ...squadState, picks: [] }).length, 1);
  // Oracle agreement on every case above.
  for (const [squad, breaches] of [[held, 0], [swap([midOut], [midIn]), 1], [swap([eze], [midIn]), 0]]) {
    assert.equal(fplLegal(squad, held, CLUB8), breaches === 0);
  }
});

test('two clubs over the limit: a transfer must fix both; exactly three is the normal squad', async () => {
  // The GW7 owner's squad as FPL holds it, with clubs moved the way a
  // deadline-day transfer moves them: the players map is the only change.
  const { bundle } = await GW7.planFor('owner');
  const squadState = bundle.squadState;
  const held = squadState.picks.map((p) => p.playerId);
  const base = fplClub(GW7.BOOTSTRAP);
  const counts = clubCounts(held, base);
  const [clubA] = [...counts].find(([, n]) => n === LIMIT) || [];
  assert.ok(clubA, 'the owner holds exactly three from one club');
  const others = held.filter((id) => base.get(id) !== clubA);
  const clubB = [...counts].map(([t]) => t).find((t) => t !== clubA && counts.get(t) === 2);
  assert.ok(clubB, 'and two from another');
  // One player joins club A (four) and one joins club B (three); later a second joins B (four).
  const [toA, toB1] = others.filter((id) => base.get(id) !== clubB);
  const moved = new Map([[toA, clubA], [toB1, clubB]]);
  const club = new Map([...base].map(([id, t]) => [id, moved.get(id) ?? t]));
  const players = new Map([...GW7.GAME_STATE.players].map(([id, p]) => [id, moved.has(id) ? { ...p, teamId: moved.get(id) } : p]));
  const gameState = { ...GW7.GAME_STATE, players };
  assert.deepEqual(overLimit(held, club).map(([t]) => t), [clubA], 'club A is over (four), club B at three');

  // Normal squad, exactly three: held is fine and buying a fourth is not.
  assert.deepEqual(clubLimitBreaches(held, GW7.GAME_STATE.players, LIMIT, held), []);
  const P7 = GW7.GAME_STATE.players;
  const outNotA = held.find((id) => base.get(id) !== clubA);
  const aIn = [...P7.values()].find((p) => base.get(p.id) === clubA && !held.includes(p.id) && p.position === P7.get(outNotA).position);
  const plusA = held.filter((id) => id !== outNotA).concat(aIn.id);
  assert.equal(clubCounts(plusA, base).get(clubA), LIMIT + 1, 'the swap makes a fourth from club A');
  assert.deepEqual(clubLimitBreaches(plusA, P7, LIMIT, held).map((b) => [b.teamId, b.count]), [[clubA, LIMIT + 1]], 'buying a fourth is a breach');
  assert.equal(fplLegal(plusA, held, base), false);

  // Move a second player to club B: now two clubs are over the limit.
  const toB2 = others.find((id) => id !== toA && id !== toB1 && club.get(id) !== clubB && club.get(id) !== clubA);
  moved.set(toB2, clubB);
  const club2 = new Map([...base].map(([id, t]) => [id, moved.get(id) ?? t]));
  const players2 = new Map([...GW7.GAME_STATE.players].map(([id, p]) => [id, moved.has(id) ? { ...p, teamId: moved.get(id) } : p]));
  const over = overLimit(held, club2).map(([t]) => t).sort();
  assert.deepEqual(over, [clubA, clubB].sort(), 'two clubs over the limit');
  assert.deepEqual(clubLimitBreaches(held, players2, LIMIT, held), [], 'held untouched: legal');
  const aPlayer = held.find((id) => club2.get(id) === clubA);
  const bPlayer = held.find((id) => club2.get(id) === clubB);
  const freeAt = (pos, extra = []) => [...players2.values()].find((p) => p.position === pos && !held.includes(p.id) && !extra.includes(p.id)
    && p.teamId !== clubA && p.teamId !== clubB && (clubCounts(held, club2).get(p.teamId) || 0) < LIMIT - 1).id;
  const fixA = held.filter((id) => id !== aPlayer).concat(freeAt(players2.get(aPlayer).position));
  assert.deepEqual(clubLimitBreaches(fixA, players2, LIMIT, held).map((b) => b.teamId), [clubB], 'fixing one club leaves the other');
  const inA = freeAt(players2.get(aPlayer).position);
  const fixBoth = held.filter((id) => id !== aPlayer && id !== bPlayer).concat(inA, freeAt(players2.get(bPlayer).position, [inA]));
  assert.deepEqual(clubLimitBreaches(fixBoth, players2, LIMIT, held), [], 'two transfers, one from each, make it legal');
  assert.equal(fplLegal(fixBoth, held, club2), true);
  assert.equal(fplLegal(fixA, held, club2), false);

  // And the planner plans that squad, every transferring week inside the limit.
  const plan2 = await buildPlan({ gameState: { ...gameState, players: players2 }, squadState, options: GW7.APP_OPTIONS });
  for (const p of [plan2.current, ...plan2.future]) {
    if (p.transferCount > 0) assert.deepEqual(overLimit(p.squad, club2), [], `GW${p.gw}`);
    else if (p === plan2.current) assert.ok(sameSquad(p.squad, held));
  }
});

test('a Wildcard and a Free Hit build a squad inside the limit from the four-Arsenal squad', async () => {
  const bundle = await plan8();
  const squadState = bundle.squadState;
  const rules = GW8.GAME_STATE.rules;
  const chips = evaluateChips({ squadState, projections: bundle.projections, gameState: GW8.GAME_STATE, rules, horizon: OPTIONS.horizon });
  for (const chip of ['wildcard', 'freehit']) {
    const e = chips.perChip[chip];
    assert.equal(e.available, true, `${chip} is still to play in this half, so it is really built`);
    const squad = e.detail.squad;
    assert.ok(Array.isArray(squad) && squad.length === rules.squadSize, `${chip} builds a squad`);
    assert.deepEqual(overLimit(squad, CLUB8), [], `${chip}: every club at three or under`);
  }
});

test('the explanations offer no move that keeps four Arsenal, and say why a single swap cannot', async () => {
  const bundle = await plan8();
  const held = bundle.squadState.picks.map((p) => p.playerId);
  const players = GW8.GAME_STATE.players;
  const rules = GW8.GAME_STATE.rules;
  // A target whose position holds no Arsenal player, so no single swap can fix the club.
  const arsenalPositions = new Set(held.filter((id) => CLUB8.get(id) === ARSENAL).map((id) => players.get(id).position));
  const pos = [...new Set([...players.values()].map((p) => p.position))].find((p) => !arsenalPositions.has(p));
  const target = [...players.values()].filter((p) => p.position === pos && !held.includes(p.id) && !bundle.current.squad.includes(p.id)
    && p.teamId !== ARSENAL && p.status === 'a').sort((a, b) => b.nowCost - a.nowCost)[0];
  const w = whyNot(target.id, { planBundle: bundle, gameState: GW8.GAME_STATE, rules });
  assert.equal(w.alternative, false, `${target.webName}: no legal single swap from the held squad`);
  assert.ok(w.blockers.some((b) => b.code === 'club_limit' && /from Arsenal, over the limit of 3 because a player moved club/.test(b.text)),
    JSON.stringify(w.blockers.map((b) => b.text)));

  // The scorer every "why not" answer compares against: the held squad rolled
  // is legal and scored, a move that keeps four is not, selling Eze is.
  const ctx = { planBundle: bundle, gameState: GW8.GAME_STATE, rules };
  const roll = scoreRoute({}, ctx);
  assert.equal(roll.legal, true, 'rolling the held squad is a legal scenario');
  assert.equal(roll.scored, true, 'and it is scored, so answers have a baseline');
  const eze = held.find((id) => nameOf8(id) === 'Eze');
  const sameAs = (id) => [...players.values()].find((p) => p.position === players.get(id).position && !held.includes(p.id)
    && p.teamId !== ARSENAL && (clubCounts(held, CLUB8).get(p.teamId) || 0) < LIMIT && p.nowCost <= players.get(id).nowCost);
  const otherMid = held.find((id) => players.get(id).position === players.get(eze).position && CLUB8.get(id) !== ARSENAL);
  assert.equal(scoreRoute({ transfersOut: [otherMid], transfersIn: [sameAs(otherMid).id] }, ctx).legal, false, 'a swap that keeps four Arsenal');
  assert.equal(scoreRoute({ transfersOut: [eze], transfersIn: [sameAs(eze).id] }, ctx).legal, true, 'selling Eze');

  const c = counterfactual(target.id, { planBundle: bundle, gameState: GW8.GAME_STATE, rules });
  for (const r of [c && c.best, ...((c && c.routes) || [])].filter(Boolean)) {
    const squad = r.squad || held.filter((id) => !(r.transfersOut || r.out || []).includes(id)).concat(r.transfersIn || r.in || []);
    assert.ok(fplLegal(squad, held, CLUB8), 'every route the explanation offers is a legal FPL squad');
  }
});

test('the week after a Free Hit reverts to a squad over the limit, and that squad is planned as held', async () => {
  // The GW7 fixture's real Free Hit manager: GW6 Free Hit, so GW7 plans the
  // GW5 squad it reverts to. One of those players is moved to a club the
  // revert squad already holds three from.
  const e = GW7.ENTRIES['free-hit'];
  const revert = e.revertPicks.picks.map((p) => p.element);
  const base = fplClub(GW7.BOOTSTRAP);
  const counts = clubCounts(revert, base);
  const full = [...counts].find(([, n]) => n === LIMIT);
  assert.ok(full, 'the revert squad holds three from one club');
  const mover = revert.find((id) => base.get(id) !== full[0]);
  const players = new Map([...GW7.GAME_STATE.players].map(([id, p]) => [id, id === mover ? { ...p, teamId: full[0] } : p]));
  const gameState = { ...GW7.GAME_STATE, players };
  const { buildSquadState } = await import('../js/engine/squad.js');
  const squadState = buildSquadState({ ...e, gameState, gw: GW7.PLAN_GW });
  const held = squadState.picks.map((p) => p.playerId);
  assert.ok(sameSquad(held, revert), 'the plan starts from the reverted squad');
  assert.equal(clubLimitBreaches(held, players, LIMIT).length, 1, 'which is over the limit at one club');

  const bundle = await buildPlan({ gameState, squadState, options: GW7.APP_OPTIONS });
  const club = new Map([...base].map(([id, t]) => [id, id === mover ? full[0] : t]));
  for (const p of [bundle.current, ...bundle.future]) {
    if (p.transferCount > 0) assert.deepEqual(overLimit(p.squad, club), [], `GW${p.gw}: a transfer brings it back inside the limit`);
  }
  assert.equal(validatePlan(bundle.current, squadState, gameState, gameState.rules).ok, true);
});
