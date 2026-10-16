// The transfer search on squads where the 2026-10-16 follow-up audit found a
// legal plan the planner ranks higher than the one it returned (registry 48).
//
// stress-12 holds two free transfers, and the better plan is three moves with
// one hit: the search's depth ignored the hits a profile allows, so with two
// free transfers a third move was never generated (`hitDepth`). The other three
// were generated or reachable but ranked on the search's fast proxy and lost
// before the planner scored them exactly (`polish` in planner.js). Each case is
// asserted both ways: the shipped search fell short, the corrected one does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAME_STATE, APP_OPTIONS, squadFor } from './helpers/gw7-fixture.mjs';
import { buildPlan, scoreCandidate, resolveOptions } from '../js/engine/planner.js';

const { cases } = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gw7-2026', 'search-cases.json'), 'utf8'));
const rules = GAME_STATE.rules;
const chipNames = [...new Set(rules.chips.map(c => c.name))];

function squadOf(c) {
  const base = squadFor(c.label);
  return {
    ...base,
    picks: c.picks.map(([playerId, purchaseTenths, sellingTenths], k) => ({
      ...base.picks[k], playerId, purchaseTenths, sellingTenths, isCaptain: false, isViceCaptain: false,
    })),
    bankTenths: c.bankTenths, freeTransfers: c.freeTransfers, transferState: undefined,
    chipsUsed: chipNames.map(name => ({ name, event: 2 })), chipsAvailable: [], freeHitGw: null, warnings: [],
  };
}

async function objectives(c, options) {
  const bundle = await buildPlan({ gameState: GAME_STATE, squadState: squadOf(c), options: { ...APP_OPTIONS, ...options } });
  const ws = bundle.squadState;
  const cfg = resolveOptions({ ...APP_OPTIONS, ...options }, rules, ws.gw);
  cfg.projectionModelVersion = bundle.projections.modelVersion;
  const held = ws.picks.map(p => p.playerId);
  const score = (out, inn) => scoreCandidate({
    candidate: { transfersOut: out, transfersIn: inn, squad: held.filter(x => !out.includes(x)).concat(inn) },
    chip: null, squadState: ws, projections: bundle.projections, gameState: GAME_STATE, rules, cfg, gw: ws.gw,
  }).objective;
  return { plan: score(bundle.current.transfersOut, bundle.current.transfersIn), better: score(c.better.out, c.better.in) };
}

for (const c of cases) {
  test(`${c.name} (${c.freeTransfers} free transfers): the planner reaches the better plan`, async () => {
    const shipped = await objectives(c, { polish: false, transferOptions: { hitDepth: false } });
    assert.ok(Math.abs(shipped.better - c.better.objective) < 1e-6, 'the fixture still scores as recorded');
    assert.ok(shipped.plan < shipped.better - 0.05, `the search as shipped until 2026-10-16 returned ${shipped.plan.toFixed(3)} against ${shipped.better.toFixed(3)}`);
    const now = await objectives(c, {});
    assert.ok(now.plan >= now.better - 1e-6, `the planner returns ${now.plan.toFixed(3)}, the better plan scores ${now.better.toFixed(3)}`);
  });
}
