// The risk profile reaches every decision it names.
//
// WHY THIS FILE EXISTS (backend audit B12, 2026-10-09). lineup.js and
// captain.js each carry a table per risk profile, and nothing passed the
// profile down to them: `scoreCandidate`, the chip evaluators, the transfer
// search and the squad builder all called them with no `risk`, so an
// "aggressive" or "conservative" manager had his eleven and armband picked as
// "balanced" while only the planner's own ranking knobs moved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan, resolveOptions, RISK_PROFILES } from '../js/engine/planner.js';
import { optimizeLineup, LINEUP_PARAMS } from '../js/engine/lineup.js';
import { chooseCaptain, CAPTAIN_PARAMS } from '../js/engine/captain.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(APP, p), 'utf8'));

function sampleWorld() {
  const files = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const b = assembleSampleBundle(Object.fromEntries(files.map(n => [n, read(`data/sample/${n}.json`)])));
  const gameState = buildGameState(b.bootstrap, b.fixtures, { fetchedAt: b.fetchedAt });
  const squadState = buildSquadState({
    entry: b.entry, history: b.history, transfers: b.transfers, picks: b.picks, gameState, gw: b.planEvent,
  });
  return { gameState, squadState };
}

test('the resolved options carry the profile into every lineup and armband the plan scores', () => {
  const rules = { totalEvents: 38 };
  for (const risk of Object.keys(RISK_PROFILES)) {
    assert.equal(resolveOptions({ risk }, rules, 10).lineupOptions.risk, risk);
  }
  assert.equal(resolveOptions({}, rules, 10).lineupOptions.risk, 'balanced');
  // An explicit weight still wins over the profile's (the replay's experiments).
  const o = resolveOptions({ risk: 'aggressive', lineupOptions: { minutesRiskWeight: 0.7 } }, rules, 10);
  assert.equal(o.lineupOptions.risk, 'aggressive');
  assert.equal(o.lineupOptions.minutesRiskWeight, 0.7);
});

test('every profile in the planner has a lineup table and a captain table to reach', () => {
  for (const risk of Object.keys(RISK_PROFILES)) {
    assert.ok(LINEUP_PARAMS.riskProfiles[risk], `lineup.js has ${risk}`);
    assert.ok(CAPTAIN_PARAMS.riskProfiles[risk], `captain.js has ${risk}`);
  }
  // The direction is one direction: more appetite for variance means less
  // penalty on a starter's spread and more weight on the armband's ceiling.
  const L = LINEUP_PARAMS.riskProfiles;
  const C = CAPTAIN_PARAMS.riskProfiles;
  assert.ok(L.conservative.riskAversion > L.balanced.riskAversion && L.balanced.riskAversion > L.aggressive.riskAversion);
  assert.ok(C.conservative.upsideWeight < C.balanced.upsideWeight && C.balanced.upsideWeight < C.aggressive.upsideWeight);
  assert.ok(RISK_PROFILES.conservative.variancePreference < 0 && RISK_PROFILES.aggressive.variancePreference > 0);
});

test('the plan\'s eleven and armband are the ones its own profile picks', async () => {
  const { gameState, squadState } = sampleWorld();
  for (const risk of Object.keys(RISK_PROFILES)) {
    const b = await buildPlan({ gameState, squadState, options: { risk, seed: 7 } });
    const p = b.current;
    const lineup = optimizeLineup(p.squad, b.projections, p.gw, gameState.rules, { seed: 7, risk, gameState });
    assert.deepEqual([...lineup.startingXI].sort((x, y) => x - y), [...p.startingXI].sort((x, y) => x - y), risk);
    const armband = chooseCaptain(lineup.startingXI, b.projections, p.gw, gameState, { risk });
    assert.equal(armband.captain, p.captain, `${risk}: captain`);
    assert.equal(armband.viceCaptain, p.viceCaptain, `${risk}: vice`);
  }
});
