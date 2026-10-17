// The transfer search held against an EXACT reference, against itself, and
// against properties any optimizer of this objective must keep.
//
// WHY THIS EXISTS. Five optimizer defects escaped CI before GW7 (registry 47,
// 48; FINDINGS "The follow-up audit of #611"): projected weeks planned on a
// shrinking horizon, a better three-move plan cut by the shortlist, hits never
// searched with two or more free transfers, the fast proxy disagreeing with the
// objective, and the "why not" route depth using a different hit allowance from
// the planner. Every one was pinned afterwards on the ONE squad that reported
// it, so the next defect of the same class (a neighbouring free-transfer count,
// bank, club situation or risk profile) could not be seen. This file checks the
// search on squads nobody reported, where the right answer is computed here by
// brute force rather than remembered from a bug.
//
// The squads are seeded variants of the five real GW7 managers
// (tests/fixtures/gw7-2026): two to four picks swapped for random legal
// players, free transfers 0 to 5, bank 0 to 4.0m, every chip spent so only
// transfers are in play. They are planned with the app's settings
// (APP_OPTIONS). To fit the time budget the projections are built once and
// injected, and future weeks are planned without transfers: neither changes
// the current decision, which the determinism test below proves on one squad.
//
// One exact `scoreCandidate` costs about 2 ms (more on a bench of doubts:
// variants 0 and 30 of seed 1 cost 26 to 46 ms each, so they are not used),
// so the reference is exhaustive over a RESTRICTED incoming pool: every legal
// single and pair whose incoming players are among the best REFERENCE_POOL of
// their position by horizon value, inside the affordability band the planner
// itself uses (bank plus the two largest selling prices in that position).
// Every owned player may be sold. That is a few hundred exact scores a squad.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAME_STATE, APP_OPTIONS, ENTRIES, squadFor } from './helpers/gw7-fixture.mjs';
import { buildPlan, scoreCandidate, resolveOptions, RISK_PROFILES } from '../js/engine/planner.js';
import { searchTransfers, resolveMaxTransfers, TRANSFER_DEFAULTS } from '../js/engine/transfers.js';
import { counterfactual } from '../js/engine/counterfactual.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const rules = GAME_STATE.rules;
const players = GAME_STATE.players;
const CHIP_NAMES = [...new Set(rules.chips.map(c => c.name))];
const LABELS = Object.keys(ENTRIES);
const UNBUYABLE = new Set(['u', 'n']);
const EPS = 1e-6;

// Incoming players per position in the exhaustive reference.
const REFERENCE_POOL = 3;
// Incoming players per position in the one-swap neighbourhood check (a subset
// of the planner's own polish pool of 16, so a converged polish passes it).
const NEIGHBOURHOOD_POOL = 8;

// ---------------------------------------------------------------- squads

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buyable = () => [...players.values()].filter(p => !UNBUYABLE.has(p.status));

function spent(state) {
  return {
    ...state, transferState: undefined,
    chipsUsed: CHIP_NAMES.map(name => ({ name, event: 2 })), chipsAvailable: [], freeHitGw: null, warnings: [],
  };
}

function clubCounts(ids) {
  const n = new Map();
  for (const id of ids) {
    const t = players.get(id).teamId;
    n.set(t, (n.get(t) || 0) + 1);
  }
  return n;
}

const legalSquad = ids => new Set(ids).size === ids.length
  && [...clubCounts(ids).values()].every(n => n <= rules.clubLimit);

/** Seed-1 variant `i`: a real manager with a few picks swapped, FT 0-5, bank 0-4.0m. */
function variant(i, overrides = {}) {
  const r = mulberry32(1000 + i);
  const base = squadFor(LABELS[i % LABELS.length]);
  const picks = base.picks.map(p => ({ ...p, isCaptain: false, isViceCaptain: false }));
  const swaps = 2 + Math.floor(r() * 3);
  for (let s = 0; s < swaps; s++) {
    const k = Math.floor(r() * picks.length);
    const leaving = players.get(picks[k].playerId);
    const ids = new Set(picks.map(p => p.playerId));
    const clubs = clubCounts([...ids].filter(id => id !== leaving.id));
    const options = buyable().filter(p => p.position === leaving.position && !ids.has(p.id)
      && (clubs.get(p.teamId) || 0) < rules.clubLimit);
    const q = options[Math.floor(r() * options.length)];
    picks[k] = { ...picks[k], playerId: q.id, purchaseTenths: q.nowCost, sellingTenths: q.nowCost };
  }
  return spent({
    ...base, picks, freeTransfers: Math.floor(r() * 6), bankTenths: Math.floor(r() * 41), ...overrides,
  });
}

// ---------------------------------------------------------------- planning

let PROJECTIONS = null;
let ANCHOR = null;

/** The app's plan for this squad (projections injected after the first). */
async function plan(squadState, options = {}, gameState = GAME_STATE) {
  const injected = PROJECTIONS ? { projections: PROJECTIONS } : {};
  const bundle = await buildPlan({
    gameState, squadState, options: { ...APP_OPTIONS, futureTransfers: false, ...injected, ...options },
  });
  if (!PROJECTIONS) PROJECTIONS = bundle.projections;
  return bundle;
}

// The anchor plan is the one built WITHOUT injected projections, so the
// determinism test can compare an injected plan with it.
async function anchor() {
  if (!ANCHOR) ANCHOR = { state: variant(8), bundle: null };
  if (!ANCHOR.bundle) ANCHOR.bundle = await plan(ANCHOR.state);
  return ANCHOR.bundle;
}

function cfgOf(bundle, options = {}) {
  const cfg = resolveOptions({ ...APP_OPTIONS, ...options }, rules, bundle.squadState.gw);
  cfg.projectionModelVersion = bundle.projections.modelVersion;
  return cfg;
}

/** Exact scorer over the planner's own objective; null when illegal. */
function scorerFor(bundle, options = {}) {
  const ws = bundle.squadState;
  const cfg = cfgOf(bundle, options);
  const held = ws.picks.map(p => p.playerId);
  let calls = 0;
  let clubRejected = 0;
  const score = (out, inn) => {
    const squad = held.filter(id => !out.includes(id)).concat(inn);
    if (!legalSquad(squad)) {
      clubRejected++;
      return null;
    }
    calls++;
    return scoreCandidate({
      candidate: { transfersOut: out, transfersIn: inn, squad },
      chip: null, squadState: ws, projections: bundle.projections, gameState: GAME_STATE, rules, cfg, gw: ws.gw,
    });
  };
  return { score, cfg, held, ws, stats: () => ({ calls, clubRejected }) };
}

function horizonValue(bundle, cfg, id) {
  let v = 0;
  for (let k = 0; k < cfg.horizon; k++) {
    const row = bundle.projections.get(id, bundle.squadState.gw + k);
    if (row) v += Math.pow(cfg.discount, k) * row.xPoints;
  }
  return v;
}

function topByValue(bundle, cfg, position, n, { band = Infinity, exclude = new Set() } = {}) {
  return buyable()
    .filter(p => p.position === position && !exclude.has(p.id) && p.nowCost <= band)
    .map(p => ({ id: p.id, v: horizonValue(bundle, cfg, p.id) }))
    .sort((a, b) => (b.v - a.v) || (a.id - b.id))
    .slice(0, n)
    .map(x => x.id);
}

/**
 * The best plan of 0, 1 and 2 moves inside the restricted pool, found by
 * enumerating every legal one: every owned player may be sold, every pool
 * player of his position bought. Hits above the profile's cap score null
 * (scoreCandidate), exactly as for the planner.
 */
function reference(bundle, options = {}) {
  const S = scorerFor(bundle, options);
  const sell = new Map(S.ws.picks.map(p => [p.playerId, p.sellingTenths]));
  const heldSet = new Set(S.held);
  const pool = new Map();
  for (const pos of Object.keys(rules.positions).map(Number)) {
    const selling = S.held.filter(id => players.get(id).position === pos).map(id => sell.get(id)).sort((a, b) => b - a);
    const band = S.ws.bankTenths + (selling[0] || 0) + (selling[1] || 0);
    pool.set(pos, topByValue(bundle, S.cfg, pos, REFERENCE_POOL, { band, exclude: heldSet }));
  }
  const best = [null, null, null];
  let plans = 0;
  const consider = (out, inn) => {
    const s = S.score(out, inn);
    if (!s) return;
    plans++;
    if (!best[out.length] || s.objective > best[out.length].objective) best[out.length] = s;
  };
  consider([], []);
  for (const o of S.held) for (const i of pool.get(players.get(o).position)) consider([o], [i]);
  for (let a = 0; a < S.held.length; a++) {
    for (let c = a + 1; c < S.held.length; c++) {
      const oa = S.held[a];
      const oc = S.held[c];
      const samePos = players.get(oa).position === players.get(oc).position;
      for (const ia of pool.get(players.get(oa).position)) {
        for (const ic of pool.get(players.get(oc).position)) {
          // (a->ia, c->ic) and (a->ic, c->ia) are the same fifteen for the same money.
          if (ia === ic || (samePos && ia > ic)) continue;
          consider([oa, oc], [ia, ic]);
        }
      }
    }
  }
  return { best, plans, cfg: S.cfg, stats: S.stats(), score: S.score };
}

/**
 * Where the planner's recommendation falls short of the reference. A free
 * plan is always admissible. A hit plan is admissible under the planner's own
 * rule (planner.js: it must beat the best free plan by `hitMarginPoints`):
 * when the recommendation is free it IS the best free plan, so a reference
 * hit plan must clear it by the margin; when the recommendation takes a hit,
 * the best free plan is at most its objective less the margin, so any hit plan
 * above it would have cleared the bar and should have been chosen.
 */
function shortfalls(bundle, ref) {
  const { cfg } = ref;
  const ft = bundle.squadState.freeTransfers;
  const depth = resolveMaxTransfers(ft, { maxHits: cfg.maxHits });
  const recommended = ref.score(bundle.current.transfersOut, bundle.current.transfersIn);
  const P = recommended.objective;
  const out = [];
  for (let k = 0; k <= 2; k++) {
    const r = ref.best[k];
    if (!r || k > depth) continue;
    const hits = r.acct.hits;
    const bar = hits === 0 || bundle.current.hits > 0 ? P : P + cfg.hitMarginPoints;
    if (hits > 0 && r.objective < bar) continue;
    if (r.objective > P + EPS) {
      out.push({ k, gap: r.objective - P, out: r.candidate.transfersOut, in: r.candidate.transfersIn });
    }
  }
  return { list: out, P };
}

/**
 * The polish's own neighbourhood, enumerated: swap one incoming player for
 * another of the best NEIGHBOURHOOD_POOL of his position, or one outgoing
 * player for another owned one of his position. The recommendation is the
 * polished leader, so no such swap may improve it.
 */
function neighbourhoodGain(bundle, options = {}) {
  const S = scorerFor(bundle, options);
  const { transfersOut: out, transfersIn: inn } = bundle.current;
  const P = S.score(out, inn).objective;
  const heldSet = new Set(S.held);
  let worst = { gap: 0 };
  let tried = 0;
  for (let m = 0; m < out.length; m++) {
    const pos = players.get(out[m]).position;
    const swaps = [];
    for (const id of topByValue(bundle, S.cfg, pos, NEIGHBOURHOOD_POOL, { exclude: heldSet })) {
      if (!inn.includes(id)) swaps.push([out, inn.map((x, k) => (k === m ? id : x))]);
    }
    for (const id of S.held) {
      if (!out.includes(id) && players.get(id).position === pos) swaps.push([out.map((x, k) => (k === m ? id : x)), inn]);
    }
    for (const [o, i] of swaps) {
      tried++;
      const s = S.score(o, i);
      if (s && s.objective - P > worst.gap) worst = { gap: s.objective - P, out: o, in: i };
    }
  }
  return { ...worst, tried };
}

const describe = (bundle) => `${bundle.squadState.freeTransfers} FT, bank ${bundle.squadState.bankTenths}, `
  + `plan ${bundle.current.transfersOut.join(',')}>${bundle.current.transfersIn.join(',')}`;

// ---------------------------------------------------------------- 1. exact reference

// Seed-1 variants chosen to cover the boundaries the defects lived on. 4 holds
// 0 free transfers (every move is a hit), 2 holds 1, 8 and 34 hold 2 (34 is a
// squad where the shortlist binds: a width of 4 misses its best pair), 37
// holds 5 with a 0.1m bank, and 12 is planned with the bank at exactly 0.
const REFERENCE_CASES = [
  { name: 'variant-4', make: () => variant(4) },
  { name: 'variant-2', make: () => variant(2) },
  { name: 'variant-8', make: () => ANCHOR.state, bundle: () => anchor() },
  { name: 'variant-34', make: () => variant(34) },
  { name: 'variant-37', make: () => variant(37) },
  { name: 'variant-12 (bank 0)', make: () => variant(12, { bankTenths: 0 }) },
  { name: 'club-bound', make: () => clubBound() },
];

// A squad holding three players of the club whose best unowned player is the
// most valuable buy in the game, so the club limit binds on the move the search
// most wants to make: the most attractive candidates are illegal unless a
// player of that club is sold in the same plan.
let CLUB = null;
function clubBound() {
  if (CLUB) return CLUB.state;
  const cfg = resolveOptions(APP_OPTIONS, rules, 7);
  const value = id => {
    let v = 0;
    for (let k = 0; k < cfg.horizon; k++) {
      const row = PROJECTIONS.get(id, 7 + k);
      if (row) v += Math.pow(cfg.discount, k) * row.xPoints;
    }
    return v;
  };
  const base = squadFor('owner');
  const picks = base.picks.map(p => ({ ...p, isCaptain: false, isViceCaptain: false }));
  const star = buyable().filter(p => !picks.some(q => q.playerId === p.id))
    .sort((a, b) => (value(b.id) - value(a.id)) || (a.id - b.id))[0];
  const club = star.teamId;
  // The weakest players of that club, bought in for players of other clubs.
  const filler = buyable().filter(p => p.teamId === club && p.id !== star.id && !picks.some(q => q.playerId === p.id))
    .sort((a, b) => (value(a.id) - value(b.id)) || (a.id - b.id));
  for (const p of filler) {
    if (picks.filter(q => players.get(q.playerId).teamId === club).length >= rules.clubLimit) break;
    const k = picks.findIndex(q => players.get(q.playerId).position === p.position && players.get(q.playerId).teamId !== club);
    if (k < 0) continue;
    picks[k] = { ...picks[k], playerId: p.id, purchaseTenths: p.nowCost, sellingTenths: p.nowCost };
  }
  CLUB = { star, club, state: spent({ ...base, picks, freeTransfers: 1, bankTenths: 15 }) };
  return CLUB.state;
}

let referencePlans = 0;
let referenceSquads = 0;
const planned = new Map();

for (const c of REFERENCE_CASES) {
  test(`exact reference, ${c.name}: the recommendation scores at least the best admissible 0-2 move plan`, async (t) => {
    await anchor();
    const bundle = c.bundle ? await c.bundle() : await plan(c.make());
    planned.set(c.name, bundle);
    const ref = reference(bundle);
    referencePlans += ref.plans;
    referenceSquads++;
    t.diagnostic(`${describe(bundle)}; ${ref.plans} reference plans, ${ref.stats.clubRejected} rejected on the club limit`);
    assert.ok(ref.plans > 1, 'the reference enumerated something');
    const { list } = shortfalls(bundle, ref);
    assert.deepEqual(list, [], `the planner returned a plan the reference beats: ${JSON.stringify(list)}`);
    if (c.name === 'club-bound') {
      const held = bundle.squadState.picks.map(p => p.playerId);
      assert.equal(held.filter(id => players.get(id).teamId === CLUB.club).length, rules.clubLimit, 'three of one club held');
      assert.ok(ref.stats.clubRejected > 0, 'the club limit rejected reference moves, so it binds');
    }
  });
}

// Squads where the property FAILS on the shipped search. Kept as named cases
// so the gap is visible and so the day the search closes it, the todo turns
// into a pass that can be promoted. Both are free two-move plans, each
// differing from the recommendation in both moves: the residual the registry
// (48) describes as the honest limit of the heuristic, here at TWO free
// transfers, inside the space the planner claims to search.
const KNOWN_MISSES = [
  {
    name: 'variant-21 (2 FT)',
    make: () => variant(21),
    todo: 'free pair 578,165>427,569 scores 194.936 against the plan 578,153>542,112 at 194.759; the pair search never generates it',
  },
  {
    name: 'audit stress-5 (2 FT)',
    make: () => stress5(),
    todo: 'free pair 391,565>112,427 scores 190.403, against the plan 565,165>427,569 at 190.003; the pair search never generates it',
  },
];

function stress5() {
  const { cases } = JSON.parse(readFileSync(join(HERE, 'fixtures', 'gw7-2026', 'search-cases.json'), 'utf8'));
  const c = cases.find(x => x.name === 'stress-5');
  const base = squadFor(c.label);
  return spent({
    ...base,
    picks: c.picks.map(([playerId, purchaseTenths, sellingTenths], k) => ({
      ...base.picks[k], playerId, purchaseTenths, sellingTenths, isCaptain: false, isViceCaptain: false,
    })),
    bankTenths: c.bankTenths, freeTransfers: c.freeTransfers,
  });
}

for (const c of KNOWN_MISSES) {
  test(`exact reference, ${c.name}: the recommendation scores at least the best admissible 0-2 move plan`, { todo: c.todo }, async (t) => {
    await anchor();
    const bundle = await plan(c.make());
    const ref = reference(bundle);
    const { list } = shortfalls(bundle, ref);
    t.diagnostic(`${describe(bundle)}; shortfalls ${JSON.stringify(list)}`);
    assert.deepEqual(list, []);
  });
}

// The polish (registry 48) is a local search; this is its neighbourhood,
// enumerated exactly, on every reference squad plus two holding five free
// transfers (variants 1 and 17), where the plans are four and five moves deep
// and outside what the pair reference can reach.
test('exact neighbourhood: no one-player swap improves any recommendation', async (t) => {
  await anchor();
  const extra = [variant(1), variant(17)];
  const bundles = [...planned.values()];
  for (const s of extra) bundles.push(await plan(s));
  let tried = 0;
  for (const b of bundles) {
    const n = neighbourhoodGain(b);
    tried += n.tried;
    assert.ok(n.gap <= EPS, `${describe(b)}: ${n.out}>${n.in} improves it by ${n.gap.toFixed(3)}`);
  }
  t.diagnostic(`${bundles.length} squads, ${tried} neighbouring plans`);
});

test('exact reference coverage', (t) => {
  t.diagnostic(`${referenceSquads} squads, ${referencePlans} reference plans scored exactly`);
  assert.equal(referenceSquads, REFERENCE_CASES.length);
  assert.ok(referencePlans > 1000, `only ${referencePlans} reference plans`);
});

// ---------------------------------------------------------------- 4. risk profiles

// The hit rule and the hit cap move with the profile: conservative takes no
// hit (pairs at one free transfer are out of its space), aggressive two with a
// 0.5 bar. The same squad, each profile against its own reference.
for (const risk of ['conservative', 'aggressive']) {
  test(`exact reference, variant-2 under the ${risk} profile`, async (t) => {
    await anchor();
    const bundle = await plan(variant(2), { risk });
    const ref = reference(bundle, { risk });
    t.diagnostic(`${describe(bundle)}; ${ref.plans} reference plans`);
    assert.ok(bundle.current.hits <= RISK_PROFILES[risk].maxHits, 'never more hits than the profile allows');
    const { list } = shortfalls(bundle, ref);
    assert.deepEqual(list, [], JSON.stringify(list));
  });
}

// ---------------------------------------------------------------- 2. differential

const RISKS = ['conservative', 'balanced', 'aggressive'];

// The depth is a spec (transfers.js THE DEPTH), written out here rather than
// read back from the function under test: K = max(2, min(5, FT + maxHits)).
test('depth: the search depth counts the hits each risk profile allows', () => {
  for (const risk of RISKS) {
    for (let ft = 0; ft <= 5; ft++) {
      const expected = Math.max(2, Math.min(TRANSFER_DEFAULTS.maxTransfersCap, ft + RISK_PROFILES[risk].maxHits));
      assert.equal(resolveMaxTransfers(ft, { maxHits: RISK_PROFILES[risk].maxHits }), expected, `${risk}, ${ft} FT`);
    }
  }
});

// The transfer search called exactly as buildPlan calls it.
function searchAsPlanner(bundle, squadState, options = {}) {
  const cfg = cfgOf(bundle, options);
  return searchTransfers({
    squadState, projections: bundle.projections, gameState: GAME_STATE, rules, horizon: cfg.horizon,
    opts: {
      discount: cfg.discount, maxHits: cfg.maxHits, maxCandidates: cfg.maxCandidates, seed: cfg.seed,
      ...cfg.lineupOptions, ...cfg.transferOptions,
    },
  });
}

// ...and the search really generates plans that deep: with two free transfers
// and one hit allowed, three-move plans exist (the stress-12 class), and with
// three and two hits allowed, five-move plans. Held to the spec, not to
// resolveMaxTransfers, so a depth that lost its hits fails here too.
test('depth: the planner\'s search reaches the depth it claims', async () => {
  const bundle = await anchor();
  for (const [ft, risk, expected] of [[2, 'balanced', 3], [3, 'aggressive', 5]]) {
    const raw = searchAsPlanner(bundle, { ...bundle.squadState, freeTransfers: ft, transferState: undefined }, { risk });
    const deepest = Math.max(...raw.map(r => r.transferCount));
    assert.equal(deepest, expected, `${risk}, ${ft} FT`);
  }
});

// The header's promise (transfers.js): "Illegal candidates never reach the
// scorer." On the club-bound squad the most attractive moves buy a fourth
// player of one club, so a search that let them through would spend places in
// its exact re-score on plans validatePlan then throws away, and return fewer
// than the shortlist it promises (six fewer here when the check was removed).
test('club limit binding: the exact re-score is never thinned by illegal plans', async () => {
  await anchor();
  const bundle = planned.get('club-bound') || await plan(clubBound());
  const raw = searchAsPlanner(bundle, bundle.squadState);
  for (const r of raw) assert.ok(legalSquad(r.squad), `${r.key} is legal`);
  assert.ok(raw.length >= TRANSFER_DEFAULTS.rerankCandidates,
    `${raw.length} plans returned, the shortlist is ${TRANSFER_DEFAULTS.rerankCandidates}`);
});

// The "why not" routes (counterfactual.js) must be exactly as deep as the
// planner searches, for every free-transfer count and profile. The route depth
// is internal; it is read from the one sentence that prints it, on a question
// no route can answer (every selling price cut to 0.1m with an empty bank, and
// the player asked about from a club the squad already holds three of).
test('depth: "why not him?" routes are as deep as the planner searches, every FT and profile', async () => {
  await anchor();
  const bundle = planned.get('club-bound') || await plan(clubBound());
  const held = bundle.squadState.picks.map(p => p.playerId);
  const target = buyable().find(p => p.teamId === CLUB.club && !held.includes(p.id));
  for (const risk of RISKS) {
    for (let ft = 0; ft <= 5; ft++) {
      const squadState = {
        ...bundle.squadState, freeTransfers: ft, transferState: undefined, bankTenths: 0,
        picks: bundle.squadState.picks.map(p => ({ ...p, sellingTenths: 1 })),
      };
      const asked = {
        ...bundle, squadState, planOptions: { ...bundle.planOptions, risk },
        current: { ...bundle.current, transfersOut: [], transfersIn: [], squad: held },
      };
      const answer = counterfactual(target.id, { planBundle: asked, gameState: GAME_STATE, rules });
      const text = (answer.blockers || []).map(b => b.text).join(' ');
      const m = text.match(/inside (\d+) transfers/);
      assert.ok(m, `${risk}, ${ft} FT: the club-limit sentence names the depth (${text})`);
      assert.equal(Number(m[1]), resolveMaxTransfers(ft, { maxHits: RISK_PROFILES[risk].maxHits }), `${risk}, ${ft} FT`);
    }
  }
});

// What the plan reports, what its alternatives report, and the order they are
// listed in must all be the objective the plan was CHOSEN on, re-derived here
// from the moves alone.
test('the plan and its alternatives report the objective they were ranked on', async () => {
  await anchor();
  assert.ok(planned.size >= 3, 'runs after the reference squads are planned');
  for (const bundle of planned.values()) {
    const S = scorerFor(bundle);
    const plan0 = bundle.current;
    const own = S.score(plan0.transfersOut, plan0.transfersIn);
    assert.ok(Math.abs(own.xPointsHorizon - plan0.xPointsHorizon) < 1e-9, `${describe(bundle)}: xPointsHorizon`);
    assert.equal(own.acct.hits, plan0.hits, 'hits');
    let prev = Infinity;
    for (const alt of plan0.alternatives) {
      const s = S.score(alt.transfersOut, alt.transfersIn);
      assert.ok(s, `${describe(bundle)}: alternative ${alt.headline} is legal`);
      assert.ok(Math.abs((s.objective - own.objective) - alt.deltaObjective) < 1e-9, `${alt.headline}: deltaObjective`);
      assert.ok(Math.abs(s.xPointsHorizon - alt.xPointsHorizon) < 1e-9, `${alt.headline}: xPointsHorizon`);
      assert.ok(alt.deltaObjective <= prev + 1e-12, `${describe(bundle)}: alternatives listed by objective`);
      prev = alt.deltaObjective;
    }
  }
});

test('planning is deterministic, and injecting the projections changes nothing', async () => {
  const first = await anchor();
  const again = await plan(ANCHOR.state);
  const pick = b => ({
    out: b.current.transfersOut, in: b.current.transfersIn, xh: b.current.xPointsHorizon,
    captain: b.current.captain, xi: b.current.startingXI,
    alts: b.current.alternatives.map(a => [a.transfersOut, a.transfersIn, a.deltaObjective]),
  });
  assert.deepEqual(pick(again), pick(first));
});

// ---------------------------------------------------------------- 3. metamorphic

// On variant 8 (two free transfers, a free two-move plan). Each change below
// keeps every plan the planner could choose before still available at the same
// or a higher objective, so an optimizer can only do at least as well. The
// base plan takes no hit, which makes the bound exact: with a hit plan the
// hit bar could legitimately trade it for a free plan up to the margin lower.
async function base() {
  const bundle = await anchor();
  assert.equal(bundle.current.hits, 0, 'the base plan is free');
  return { bundle, P: scorerFor(bundle).score(bundle.current.transfersOut, bundle.current.transfersIn).objective };
}
const objectiveOf = b => scorerFor(b).score(b.current.transfersOut, b.current.transfersIn).objective;

test('metamorphic: more money in the bank never lowers the best plan', async () => {
  const { P } = await base();
  const richer = await plan({ ...ANCHOR.state, bankTenths: ANCHOR.state.bankTenths + 10 });
  assert.ok(objectiveOf(richer) >= P - EPS, `${objectiveOf(richer)} < ${P}`);
});

test('metamorphic: one more free transfer never lowers the best plan', async () => {
  const { P } = await base();
  const more = await plan({ ...ANCHOR.state, freeTransfers: ANCHOR.state.freeTransfers + 1 });
  assert.ok(objectiveOf(more) >= P - EPS, `${objectiveOf(more)} < ${P}`);
});

test('metamorphic: a better unowned player never lowers the best plan', async () => {
  const { bundle, P } = await base();
  const cfg = cfgOf(bundle);
  const held = new Set(bundle.squadState.picks.map(p => p.playerId));
  const used = new Set(bundle.current.transfersIn);
  // A mid-table midfielder the plan does not buy, made a point a week better.
  const mids = topByValue(bundle, cfg, 3, 40, { exclude: new Set([...held, ...used]) });
  const lifted = mids[20];
  const byPlayer = new Map(bundle.projections.byPlayer);
  byPlayer.set(lifted, byPlayer.get(lifted).map(r => ({ ...r, xPoints: r.xPoints + 1, ceiling: (r.ceiling || 0) + 1 })));
  const projections = {
    ...bundle.projections, byPlayer,
    get(id, gw) {
      const rows = byPlayer.get(id);
      const i = gw - bundle.projections.gwFrom;
      return rows && i >= 0 && i < rows.length ? rows[i] : null;
    },
  };
  const better = await plan(ANCHOR.state, { projections });
  assert.ok(objectiveOf(better) >= P - EPS, `lifting ${lifted}: ${objectiveOf(better)} < ${P}`);
});

test('metamorphic: removing a player the plan does not use never changes the plan', async () => {
  const { bundle } = await base();
  const cfg = cfgOf(bundle);
  const held = new Set(bundle.squadState.picks.map(p => p.playerId));
  const used = new Set(bundle.current.transfersIn);
  // The most valuable unowned forward the plan does not buy: a player every
  // pool contains, so the removal really reaches the search.
  const gone = topByValue(bundle, cfg, 4, 1, { exclude: new Set([...held, ...used]) })[0];
  const without = new Map(players);
  without.set(gone, { ...players.get(gone), status: 'u' });
  const after = await plan(ANCHOR.state, {}, { ...GAME_STATE, players: without });
  assert.deepEqual(
    [after.current.transfersOut.slice().sort(), after.current.transfersIn.slice().sort(), after.current.xPointsHorizon],
    [bundle.current.transfersOut.slice().sort(), bundle.current.transfersIn.slice().sort(), bundle.current.xPointsHorizon],
    `removing ${gone}`,
  );
});
