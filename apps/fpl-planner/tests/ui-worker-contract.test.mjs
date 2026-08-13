import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { whyNot } from '../js/engine/explain.js';
import { toWireBundle, getProjection, pitchRows } from '../js/ui/plan-model.js';

// THE WORKER BOUNDARY.
//
// Plan generation runs in js/worker.js and the result is posted back, which is
// a structured clone. structuredClone THROWS on a function, and a ProjectionSet
// carries a get() method, so the bundle has to be stripped first. These tests
// are the reason the UI never calls projections.get().

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const gameState = buildGameState(
  { ...read('fixtures', 'bootstrap.json'), events: read('fixtures', 'events-in-season.json') },
  read('fixtures', 'fixtures.json'),
  { fetchedAt: '2026-09-24T10:00:00Z' },
);
const squadState = buildSquadState({
  entry: read('fixtures', 'entry.json'),
  history: read('fixtures', 'entry-history.json'),
  transfers: read('fixtures', 'entry-transfers.json'),
  picks: read('fixtures', 'entry-picks.json'),
  gameState,
  gw: 6,
});

const bundle = await buildPlan({ gameState, squadState, options: { horizon: 3, seed: 7 } });

test('the raw bundle cannot cross a worker boundary, which is why it is stripped', () => {
  assert.equal(typeof bundle.projections.get, 'function');
  assert.throws(() => structuredClone(bundle), /could not be cloned|DataCloneError/i);
});

test('the wire bundle survives a structured clone with its Map intact', () => {
  const wire = toWireBundle(bundle);
  const cloned = structuredClone(wire);
  assert.ok(cloned.projections.byPlayer instanceof Map);
  assert.equal(cloned.projections.byPlayer.size, bundle.projections.byPlayer.size);
  assert.equal(cloned.projections.gwFrom, bundle.projections.gwFrom);
  assert.equal(cloned.current.gw, bundle.current.gw);
  assert.equal(cloned.dataStatus.modelVersion, bundle.dataStatus.modelVersion);
  assert.equal(cloned.validation.ok, true);
});

test('the game state itself clones, so the worker gets the same world the UI renders', () => {
  const cloned = structuredClone(gameState);
  assert.ok(cloned.players instanceof Map);
  assert.equal(cloned.players.size, gameState.players.size);
  assert.equal(cloned.rules.squadSize, gameState.rules.squadSize);
});

test('every number the dashboard shows survives the trip', () => {
  const wire = structuredClone(toWireBundle(bundle));
  const plan = wire.current;
  for (const field of ['gw', 'transferCount', 'hits', 'hitCostPoints', 'bankBeforeTenths', 'bankAfterTenths', 'xPointsGw', 'xPointsNet', 'xPointsHorizon', 'formation', 'captain', 'viceCaptain', 'horizon', 'durationMs']) {
    assert.notEqual(plan[field], undefined, `plan.${field} crossed the boundary`);
  }
  assert.ok(Array.isArray(plan.explanation.bullets) && plan.explanation.bullets.length > 0);
  for (const bullet of plan.explanation.bullets) {
    assert.equal(typeof bullet.text, 'string');
    assert.equal(typeof bullet.value, 'number', `bullet ${bullet.code} carries its engine number`);
  }
  assert.equal(typeof wire.dataStatus.durationMs, 'number');
  assert.equal(typeof wire.dataStatus.sample, 'boolean');
});

test('projections are readable after the clone, through byPlayer alone', () => {
  const wire = structuredClone(toWireBundle(bundle));
  const row = getProjection(wire.projections, wire.current.captain, wire.current.gw);
  assert.ok(row, 'the captain has a projection for the planned gameweek');
  assert.equal(typeof row.xPoints, 'number');
  assert.ok(Array.isArray(row.fixtures));
  assert.equal(wire.projections.get, undefined, 'the convenience accessor is gone, as expected');
});

test('the pitch can be laid out from the cloned plan alone', () => {
  const wire = structuredClone(toWireBundle(bundle));
  const positionOf = id => gameState.players.get(id).position;
  const rows = pitchRows(wire.current.startingXI, wire.current.formation, positionOf);
  assert.equal(rows.length, wire.current.formation.split('-').length + 1);
  assert.equal(rows.flat().length, 11, 'every starter lands in exactly one row');
  assert.equal(rows[0].length, 1, 'one goalkeeper');
  assert.equal(new Set(rows.flat()).size, 11);
});

test('"why not" needs the live ProjectionSet, which is why it is answered in the worker', () => {
  const owned = new Set(bundle.current.squad);
  // Somebody the manager could actually sign: an unaffordable target is blocked
  // on price alone and never reaches the projections.
  let outsider = null;
  let answer = null;
  for (const player of gameState.players.values()) {
    if (owned.has(player.id) || player.status !== 'a') continue;
    const candidate = whyNot(player.id, { planBundle: bundle, gameState, rules: gameState.rules });
    if (candidate.deltaHorizon !== null) { outsider = player; answer = candidate; break; }
  }
  assert.ok(outsider, 'the fixture contains at least one affordable target');
  assert.ok(answer.text.includes(outsider.webName));
  assert.equal(typeof answer.deltaHorizon, 'number');

  // The same call against a cloned bundle fails loudly rather than answering
  // with zeroes, because re-running the optimization needs the ProjectionSet's
  // accessor. That is why the runner keeps the unstripped bundle (inside the
  // worker, or in memory on the inline path) and never answers from the wire
  // copy the UI holds.
  const wire = structuredClone(toWireBundle(bundle));
  assert.throws(
    () => whyNot(outsider.id, { planBundle: wire, gameState, rules: gameState.rules }),
    /projections\.get is not a function/,
  );
});
