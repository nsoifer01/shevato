// The headline guarantee (SPEC 13.2): an illegal or unaffordable plan is
// impossible.
//
// Randomised, seeded scenarios are driven end to end through the optimizers and
// every plan that comes out is put back through validate.js. The generator is
// deliberately hostile: empty banks, squads already at the club limit, benches
// where nobody can play, blank gameweeks that leave a position barely able to
// field a legal eleven, no free transfers, the maximum free transfers, chips
// already spent, and a double gameweek.
//
// Everything is driven from a seeded generator, so a failure here is
// reproducible from the scenario index printed with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { buildSquadState } from '../js/engine/squad.js';
import { sellingPrice, chipAvailableAt } from '../js/engine/rules.js';
import { optimizeLineup } from '../js/engine/lineup.js';
import { chooseCaptain } from '../js/engine/captain.js';
import { searchTransfers } from '../js/engine/transfers.js';
import { buildSquad } from '../js/engine/squad-builder.js';
import { validatePlan, assertValidPlan } from '../js/engine/validate.js';
import { buildPlan } from '../js/engine/planner.js';
import { makeRng } from '../js/engine/ml.js';
import { assembleSampleBundle } from '../js/data/sample.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const gameState = buildGameState(
  { ...read('fixtures', 'bootstrap.json'), events: read('fixtures', 'events-in-season.json') },
  read('fixtures', 'fixtures.json'),
  { fetchedAt: '2026-09-24T10:00:00Z' },
);
const rules = gameState.rules;
const strength = buildStrength(gameState, { asOfGw: 5 });
// GW5 is a blank for clubs 4 and 6 and GW6 is their double, so both live inside
// the projected range.
const projections = buildProjections({ gameState, strength, gwFrom: 5, gwTo: 12 });

const byPosition = new Map();
for (const p of gameState.players.values()) {
  if (!byPosition.has(p.position)) byPosition.set(p.position, []);
  byPosition.get(p.position).push(p);
}
for (const list of byPosition.values()) list.sort((a, b) => a.id - b.id);

const BLANK_CLUBS = [4, 6];
const UNFIT = new Set(['i', 's', 'u', 'n', 'd']);

// --- scenario generation ----------------------------------------------------

function shuffled(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const k = Math.floor(rng() * (i + 1));
    [out[i], out[k]] = [out[k], out[i]];
  }
  return out;
}

// A legal fifteen: exact position quotas, at most three from any club. `prefer`
// pushes a family of players to the front of every position pool so a scenario
// can force an injured bench or a blanked spine.
function randomSquad(rng, prefer) {
  const clubs = new Map();
  const squad = [];
  for (const pos of Object.values(rules.positions)) {
    let pool = shuffled(byPosition.get(pos.id), rng);
    if (prefer) {
      const wanted = pool.filter(prefer);
      pool = wanted.concat(pool.filter(p => !prefer(p)));
    }
    let taken = 0;
    for (const p of pool) {
      if (taken === pos.squadSelect) break;
      if ((clubs.get(p.teamId) || 0) >= rules.clubLimit) continue;
      clubs.set(p.teamId, (clubs.get(p.teamId) || 0) + 1);
      squad.push(p.id);
      taken++;
    }
    if (taken < pos.squadSelect) return null;
  }
  return squad;
}

const FAMILIES = [
  {
    name: 'near-zero bank',
    build: (rng) => ({ squad: randomSquad(rng), bank: Math.floor(rng() * 3), freeTransfers: 1 + Math.floor(rng() * 2), gw: 6 }),
  },
  {
    name: 'rich bank',
    build: (rng) => ({ squad: randomSquad(rng), bank: 40 + Math.floor(rng() * 60), freeTransfers: 1, gw: 6 }),
  },
  {
    name: 'no free transfers',
    build: (rng) => ({ squad: randomSquad(rng), bank: Math.floor(rng() * 20), freeTransfers: 0, gw: 6 }),
  },
  {
    name: 'free transfers at the cap',
    build: (rng) => ({ squad: randomSquad(rng), bank: Math.floor(rng() * 20), freeTransfers: rules.maxFreeTransfers, gw: 6 }),
  },
  {
    name: 'everybody unfit',
    // Injured, suspended, unavailable and doubtful players first, so the eleven
    // and the bench are both full of players who may not kick a ball.
    build: (rng) => ({ squad: randomSquad(rng, p => UNFIT.has(p.status)), bank: Math.floor(rng() * 10), freeTransfers: Math.floor(rng() * 3), gw: 6 }),
  },
  {
    name: 'blank gameweek',
    // Clubs 4 and 6 have no GW5 fixture, so a squad stuffed with them has to
    // field a legal eleven out of players worth nothing.
    build: (rng) => ({ squad: randomSquad(rng, p => BLANK_CLUBS.includes(p.teamId)), bank: Math.floor(rng() * 10), freeTransfers: Math.floor(rng() * 3), gw: 5 }),
  },
  {
    name: 'double gameweek',
    build: (rng) => ({ squad: randomSquad(rng, p => BLANK_CLUBS.includes(p.teamId)), bank: Math.floor(rng() * 15), freeTransfers: 1 + Math.floor(rng() * 3), gw: 6 }),
  },
  {
    name: 'club limit already reached',
    // Three from one club in the squad, so a whole set of transfers is illegal.
    build: (rng) => {
      const club = 1 + Math.floor(rng() * 20);
      return { squad: randomSquad(rng, p => p.teamId === club), bank: Math.floor(rng() * 20), freeTransfers: 1 + Math.floor(rng() * 2), gw: 6 };
    },
  },
  {
    name: 'chips already spent',
    build: (rng) => ({
      squad: randomSquad(rng),
      bank: Math.floor(rng() * 20),
      freeTransfers: Math.floor(rng() * 3),
      gw: 6 + Math.floor(rng() * 4),
      chipsUsed: shuffled(['wildcard', 'freehit', 'bboost', '3xc'], rng)
        .slice(0, 1 + Math.floor(rng() * 3))
        .map(name => ({ name, event: 2 + Math.floor(rng() * 3) })),
    }),
  },
];

// Prices move, so selling prices are reconstructed through the real sell-on
// rule rather than assumed equal to now_cost.
function pricedPicks(squad, rng) {
  return squad.map((id, i) => {
    const player = gameState.players.get(id);
    const drift = Math.floor(rng() * 13) - 6;
    const purchase = Math.max(35, player.nowCost - drift);
    return {
      playerId: id,
      slot: i + 1,
      purchaseTenths: purchase,
      sellingTenths: sellingPrice(purchase, player.nowCost, rules),
    };
  });
}

function makeScenario(index, rng) {
  const family = FAMILIES[index % FAMILIES.length];
  const spec = family.build(rng);
  if (!spec.squad) return null;
  const picks = pricedPicks(spec.squad, rng);
  const chipsUsed = spec.chipsUsed || [];
  return {
    index,
    family: family.name,
    squadState: {
      entryId: 1000 + index,
      gw: spec.gw,
      picks,
      bankTenths: spec.bank,
      squadValueTenths: picks.reduce((s, p) => s + p.sellingTenths, 0) + spec.bank,
      freeTransfers: spec.freeTransfers,
      chipsUsed,
      chipsAvailable: ['wildcard', 'freehit', 'bboost', '3xc']
        .filter(name => chipAvailableAt(rules, name, spec.gw, chipsUsed)),
      source: 'picks',
      warnings: [],
    },
  };
}

// The plan a manager who makes no transfers would submit, assembled from the
// optimizers exactly as the planner assembles it.
function holdPlan(squadState, chip = null) {
  const squad = squadState.picks.map(p => p.playerId);
  const lineup = optimizeLineup(squad, projections, squadState.gw, rules, { gameState });
  const armband = chooseCaptain(lineup.startingXI, projections, squadState.gw, gameState);
  return {
    gw: squadState.gw,
    chip,
    transfersOut: [],
    transfersIn: [],
    transferCount: 0,
    freeTransfersUsed: 0,
    freeTransfersAfter: squadState.freeTransfers,
    hits: 0,
    hitCostPoints: 0,
    bankBeforeTenths: squadState.bankTenths,
    moneyInTenths: 0,
    moneyOutTenths: 0,
    bankAfterTenths: squadState.bankTenths,
    squad,
    startingXI: lineup.startingXI,
    formation: lineup.formation,
    bench: lineup.bench,
    captain: armband.captain,
    viceCaptain: armband.viceCaptain,
    xPointsGw: lineup.xPoints + lineup.autosubValue + armband.xPointsCaptaincy,
    xPointsNet: lineup.xPoints + lineup.autosubValue + armband.xPointsCaptaincy,
  };
}

// --- the property test ------------------------------------------------------

const SCENARIOS = 320;
// A light search configuration for the bulk of the run, and the real defaults
// on a slice of it: legality cannot depend on how wide the search was.
const LIGHT = { poolPerPosition: 6, pairPoolPerPosition: 3, enablersPerPosition: 2, maxOutCandidates: 4, maxCandidates: 4 };

test(`${SCENARIOS} randomized scenarios produce zero violations`, (t) => {
  const started = Date.now();
  const rng = makeRng(20260810);
  const counts = new Map();
  let scenarios = 0;
  let plansValidated = 0;
  let squadsBuilt = 0;
  let rolls = 0;
  let hits = 0;
  let chipPlans = 0;

  for (let i = 0; i < SCENARIOS; i++) {
    const scenario = makeScenario(i, rng);
    assert.ok(scenario, `scenario ${i} could not be generated`);
    const { squadState } = scenario;
    counts.set(scenario.family, (counts.get(scenario.family) || 0) + 1);
    scenarios++;

    // 1. The plan for a manager who does nothing.
    const hold = holdPlan(squadState);
    const holdResult = validatePlan(hold, squadState, gameState, rules);
    assert.deepEqual(holdResult.violations, [],
      `scenario ${i} (${scenario.family}) hold plan: ${JSON.stringify(holdResult.violations)}`);
    plansValidated++;

    // 2. The same squad with a legal chip attached.
    const chip = squadState.chipsAvailable.find(name => name === 'bboost' || name === '3xc');
    if (chip) {
      const chipped = holdPlan(squadState, chip);
      const chipResult = validatePlan(chipped, squadState, gameState, rules);
      assert.deepEqual(chipResult.violations, [],
        `scenario ${i} (${scenario.family}) ${chip} plan: ${JSON.stringify(chipResult.violations)}`);
      plansValidated++;
      chipPlans++;
    }

    // 3. Every transfer plan the search is willing to recommend.
    const opts = i % 8 === 0 ? {} : LIGHT;
    const plans = searchTransfers({ squadState, projections, gameState, rules, horizon: 5, opts });
    assert.ok(plans.length > 0, `scenario ${i} (${scenario.family}) produced no plan at all`);
    assert.ok(plans.some(p => p.transferCount === 0), `scenario ${i} lost the option of doing nothing`);
    for (const plan of plans) {
      const result = validatePlan(plan, squadState, gameState, rules);
      assert.deepEqual(result.violations, [],
        `scenario ${i} (${scenario.family}) plan ${plan.key}: ${JSON.stringify(result.violations)}`);
      assert.ok(plan.bankAfterTenths >= 0);
      assert.ok(Number.isInteger(plan.bankAfterTenths));
      plansValidated++;
      if (plan.transferCount === 0) rolls++;
      if (plan.hits > 0) hits++;
    }

    // 4. Occasionally rebuild the whole squad, which is what a wildcard does.
    if (i % 40 === 0) {
      const built = buildSquad({
        projections,
        gameState,
        rules,
        gw: squadState.gw,
        horizon: 5,
        budgetTenths: squadState.squadValueTenths,
        opts: { seed: 100 + i },
      });
      const freshState = {
        gw: squadState.gw,
        picks: [],
        bankTenths: squadState.squadValueTenths,
        freeTransfers: rules.maxFreeTransfers,
        chipsUsed: squadState.chipsUsed,
      };
      const lineup = optimizeLineup(built.squad, projections, squadState.gw, rules, { gameState });
      const armband = chooseCaptain(lineup.startingXI, projections, squadState.gw, gameState);
      const plan = {
        gw: squadState.gw,
        chip: chipAvailableAt(rules, 'wildcard', squadState.gw, squadState.chipsUsed) ? 'wildcard' : null,
        transfersOut: [],
        transfersIn: [],
        transferCount: 0,
        freeTransfersUsed: 0,
        hits: 0,
        hitCostPoints: 0,
        bankBeforeTenths: squadState.squadValueTenths,
        moneyInTenths: 0,
        moneyOutTenths: built.costTenths,
        bankAfterTenths: built.bankTenths,
        squad: built.squad,
        startingXI: lineup.startingXI,
        formation: lineup.formation,
        bench: lineup.bench,
        captain: armband.captain,
        viceCaptain: armband.viceCaptain,
      };
      assert.doesNotThrow(() => assertValidPlan(plan, freshState, gameState, rules));
      plansValidated++;
      squadsBuilt++;
    }
  }

  const durationMs = Date.now() - started;
  t.diagnostic(`scenarios: ${scenarios}, plans validated: ${plansValidated}, squads rebuilt: ${squadsBuilt}`);
  t.diagnostic(`rolls seen: ${rolls}, hit plans seen: ${hits}, chip plans: ${chipPlans}`);
  t.diagnostic(`families: ${[...counts].map(([k, v]) => `${k} x${v}`).join(', ')}`);
  t.diagnostic(`duration: ${durationMs} ms (${(durationMs / scenarios).toFixed(1)} ms per scenario)`);

  assert.equal(scenarios, SCENARIOS);
  assert.ok(plansValidated >= 300, `only ${plansValidated} plans were validated`);
  assert.equal(counts.size, FAMILIES.length, 'every adversarial family should have run');
  assert.ok(rolls >= SCENARIOS, 'holding should be an option in every scenario');
  assert.ok(hits > 0, 'the search should be willing to take a hit somewhere in 320 scenarios');
  assert.ok(chipPlans > 0, 'chip plans should have been exercised');
});

// --- the generator is genuinely adversarial ---------------------------------

test('the scenario generator really produces the hard cases it claims to', () => {
  const rng = makeRng(20260810);
  let clubAtLimit = 0;
  let unfitBench = 0;
  let blankStarters = 0;
  let zeroBank = 0;

  for (let i = 0; i < SCENARIOS; i++) {
    const scenario = makeScenario(i, rng);
    const squad = scenario.squadState.picks.map(p => p.playerId);
    const clubs = new Map();
    for (const id of squad) {
      const teamId = gameState.players.get(id).teamId;
      clubs.set(teamId, (clubs.get(teamId) || 0) + 1);
    }
    if ([...clubs.values()].some(n => n === rules.clubLimit)) clubAtLimit++;
    if (squad.filter(id => UNFIT.has(gameState.players.get(id).status)).length >= 2) unfitBench++;
    if (scenario.squadState.gw === 5
      && squad.filter(id => BLANK_CLUBS.includes(gameState.players.get(id).teamId)).length >= 5) blankStarters++;
    if (scenario.squadState.bankTenths === 0) zeroBank++;
  }

  assert.ok(clubAtLimit > 50, `only ${clubAtLimit} scenarios sat at the club limit`);
  assert.ok(unfitBench > 20, `only ${unfitBench} scenarios carried unfit players`);
  assert.ok(blankStarters > 20, `only ${blankStarters} scenarios had a blanked spine`);
  assert.ok(zeroBank > 5, `only ${zeroBank} scenarios had an empty bank`);
});

test('an illegal squad is caught rather than quietly optimised', () => {
  // The mirror image of the property test: if the generator ever produced an
  // illegal squad, validate.js has to say so. Four players from one club, built
  // by hand, must fail.
  const rng = makeRng(4);
  const scenario = makeScenario(0, rng);
  const squad = scenario.squadState.picks.map(p => p.playerId);
  const plan = holdPlan(scenario.squadState);

  const clubCounts = new Map();
  for (const id of squad) {
    const teamId = gameState.players.get(id).teamId;
    clubCounts.set(teamId, (clubCounts.get(teamId) || 0) + 1);
  }
  // Someone at a club the squad is already full of, who plays the position of
  // somebody the squad holds from a different club: swapping them in keeps
  // every count right and puts four players from one club on the pitch.
  let intruder = null;
  let victim = null;
  for (const player of gameState.players.values()) {
    if (squad.includes(player.id)) continue;
    if ((clubCounts.get(player.teamId) || 0) < rules.clubLimit) continue;
    victim = squad.find(id => gameState.players.get(id).position === player.position
      && gameState.players.get(id).teamId !== player.teamId);
    if (victim) { intruder = player; break; }
  }
  assert.ok(intruder, 'the fixture needs a spare player at a club the squad is already full of');

  const swap = (list) => list.map(id => (id === victim ? intruder.id : id));
  const broken = {
    ...plan,
    squad: swap(plan.squad),
    startingXI: swap(plan.startingXI),
    bench: { gk: plan.bench.gk === victim ? intruder.id : plan.bench.gk, order: swap(plan.bench.order) },
    captain: plan.captain === victim ? intruder.id : plan.captain,
    viceCaptain: plan.viceCaptain === victim ? intruder.id : plan.viceCaptain,
  };
  const result = validatePlan(broken, scenario.squadState, gameState, rules);
  assert.ok(result.violations.some(v => v.code === 'club_limit'), JSON.stringify(result.violations));
});

// --- performance (SPEC 13.4) ------------------------------------------------

// The documented budget for a full transfer search over a realistic dataset,
// measured on the sample data (320 players, 380 fixtures). The observed cost on
// the development machine is roughly 100 ms, so this leaves an order of
// magnitude of headroom for a slower CI runner before it fails.
const TRANSFER_SEARCH_BUDGET_MS = 1500;

test('a full transfer search over the sample dataset stays inside its budget', (t) => {
  const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const files = Object.fromEntries(names.map(n => [n, read('..', 'data', 'sample', `${n}.json`)]));
  const bundle = assembleSampleBundle(files);

  const sampleState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  assert.ok(sampleState.players.size >= 300, `sample dataset has only ${sampleState.players.size} players`);
  assert.ok(sampleState.fixtures.length >= 300);

  const sampleStrength = buildStrength(sampleState, { asOfGw: bundle.currentEvent });
  const projectionStart = Date.now();
  const sampleProjections = buildProjections({
    gameState: sampleState,
    strength: sampleStrength,
    gwFrom: bundle.planEvent,
    gwTo: bundle.planEvent + 4,
  });
  const projectionMs = Date.now() - projectionStart;

  const squadState = buildSquadState({
    entry: bundle.entry,
    history: bundle.history,
    transfers: bundle.transfers,
    picks: bundle.picks,
    gameState: sampleState,
    gw: bundle.planEvent,
  });
  assert.equal(squadState.picks.length, rules.squadSize);

  const timings = [];
  let plans = [];
  for (let run = 0; run < 3; run++) {
    const started = Date.now();
    plans = searchTransfers({
      squadState,
      projections: sampleProjections,
      gameState: sampleState,
      rules: sampleState.rules,
      horizon: 5,
    });
    timings.push(Date.now() - started);
  }
  const median = timings.slice().sort((a, b) => a - b)[1];

  t.diagnostic(`projections for 320 players over 5 gameweeks: ${projectionMs} ms`);
  t.diagnostic(`transfer search runs: ${timings.join(', ')} ms (median ${median} ms, budget ${TRANSFER_SEARCH_BUDGET_MS} ms)`);
  t.diagnostic(`plans returned: ${plans.length}, best: ${plans[0].transferCount} transfer(s)`);

  assert.ok(median < TRANSFER_SEARCH_BUDGET_MS, `transfer search took ${median} ms`);

  // A budget that is met by returning nothing is not a budget.
  assert.ok(plans.length > 1);
  for (const plan of plans) {
    assert.deepEqual(validatePlan(plan, squadState, sampleState, sampleState.rules).violations, []);
  }
});

// SPEC 13.4 asks for a budget on PLAN GENERATION, and the test above only
// covers the transfer search inside it. That gap let the end-to-end cost drift
// unmeasured: it more than doubled when the lineup optimizer was made exact,
// and nothing would have failed. This covers the whole `buildPlan` path the
// user actually waits on, at the shipped default horizon.
const PLAN_GENERATION_BUDGET_MS = 3000;

test('end to end plan generation stays inside its budget at the default horizon', async (t) => {
  const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const files = Object.fromEntries(names.map(n => [n, read('..', 'data', 'sample', `${n}.json`)]));
  const bundle = assembleSampleBundle(files);
  const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  const squadState = buildSquadState({
    entry: bundle.entry,
    history: bundle.history,
    transfers: bundle.transfers,
    picks: bundle.picks,
    gameState,
    gw: bundle.planEvent,
  });

  const timings = [];
  let out = null;
  for (let run = 0; run < 3; run++) {
    const started = Date.now();
    out = await buildPlan({ gameState, squadState, options: { seed: 7 } });
    timings.push(Date.now() - started);
  }
  const median = timings.slice().sort((a, b) => a - b)[1];

  t.diagnostic(`buildPlan runs: ${timings.join(', ')} ms (median ${median} ms, budget ${PLAN_GENERATION_BUDGET_MS} ms)`);
  t.diagnostic(`horizon used: ${out.current.horizon}, reported durationMs: ${Math.round(out.current.durationMs)}`);

  assert.ok(median < PLAN_GENERATION_BUDGET_MS, `plan generation took ${median} ms`);

  // A budget met by producing nothing, or something illegal, is not a budget.
  assert.equal(out.current.startingXI.length, 11);
  assert.equal(out.validation.ok, true);
  assert.deepEqual(validatePlan(out.current, squadState, gameState, gameState.rules).violations, []);
});
