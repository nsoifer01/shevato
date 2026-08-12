// What the trained model artifact is allowed to touch, and what it is not.
//
// The seam works: an artifact is resolved through models/index.json, only the
// parts it declares in engineConsumes are passed on, a malformed one falls back
// instead of reaching the engine, and a declared part really does change the
// projections. What changed is the current artifact's answer. v2 declares
// engineConsumes: [], because its start calibrator improves start-probability
// metrics on held-out data and lost season points in two leakage-free replays
// (see engineConsumesDisabledBecause in the artifact), so today the engine is
// handed nothing and every plan reports the analytic version.
//
// These tests pin both halves: nothing from the shipped artifact reaches a
// plan, AND an artifact that does declare a key is still consumed, so the
// mechanism is dormant rather than dead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadModel, selectModel, currentEntry, describeModelStatus } from '../js/data/model.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections, DEFAULT_MODEL_VERSION } from '../js/engine/projections.js';
import { buildPlan } from '../js/engine/planner.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));
const MODELS_DIR = join(here, '..', 'models');

// A fetch that serves the real models/ directory off disk. The browser fetches
// these files over HTTP; the bytes are the same ones.
function fileFetch(dir = MODELS_DIR) {
  return async (url) => {
    const name = String(url).split('/').pop();
    try {
      const body = readFileSync(join(dir, name), 'utf8');
      return { ok: true, status: 200, json: async () => JSON.parse(body) };
    } catch {
      return { ok: false, status: 404, json: async () => ({}) };
    }
  };
}

const INDEX = read('..', 'models', 'index.json');

/* ------------------------------------------------------- resolving current */

test('the current model is resolved through index.json, not a hardcoded filename', () => {
  const entry = currentEntry(INDEX);
  const highest = INDEX.models.reduce((a, b) => (b.version > a.version ? b : a));
  assert.equal(entry.file, highest.file);
  assert.equal(entry.modelVersion, highest.modelVersion);
});

test('a newer artifact appended to the index wins without a code change', () => {
  const withNext = { models: [...INDEX.models, { version: 99, modelVersion: 'fpl-planner-v99', file: 'fpl-planner-v99.json' }] };
  assert.equal(currentEntry(withNext).file, 'fpl-planner-v99.json');
  // Order in the file is not what decides it.
  const shuffled = { models: [...withNext.models].reverse() };
  assert.equal(currentEntry(shuffled).file, 'fpl-planner-v99.json');
});

test('an index with no usable entry resolves to nothing rather than guessing', () => {
  assert.equal(currentEntry(null), null);
  assert.equal(currentEntry({ models: [] }), null);
  assert.equal(currentEntry({ models: [{ modelVersion: 'x' }] }), null, 'no file name');
});

/* ---------------------------------------------------------- what is passed */

test('the shipped artifact loads and hands the engine nothing', async () => {
  const status = await loadModel({ basePath: `${MODELS_DIR}/`, fetchImpl: fileFetch() });
  assert.equal(status.ok, true, status.reason || '');
  assert.equal(status.modelVersion, currentEntry(INDEX).modelVersion);
  assert.deepEqual(status.consumed, []);
  // Null, not a bare { modelVersion }: projections.js reports whatever version
  // it is handed, so a stub would label an analytic plan with the artifact.
  assert.equal(status.model, null);
});

test('an empty engineConsumes is a healthy state, not a load failure', () => {
  const status = selectModel({
    modelVersion: 'test-1',
    engineConsumes: [],
    startCalibratorJSON: { method: 'bins', points: [{ x: 0.1, y: 0.05 }, { x: 0.9, y: 0.95 }] },
  });
  assert.equal(status.ok, true, 'the artifact is fine, it just offers the engine nothing');
  assert.equal(status.reason, null);
  assert.deepEqual(status.consumed, []);
  // The calibrator it still carries is not smuggled through by being present.
  assert.equal(status.model, null);
});

test('the artifact keeps its calibrator and records why it is switched off', () => {
  const artifact = read('..', 'models', currentEntry(INDEX).file);
  assert.deepEqual(artifact.engineConsumes, [], 'nothing is consumed');
  assert.ok(artifact.startCalibratorJSON, 'the calibrator stays in the file so the decision can be re-tested');
  const why = artifact.engineConsumesDisabledBecause;
  assert.ok(typeof why === 'string' && why.length > 200, 'and the reason travels with it');
  assert.match(why, /2024-25/);
  assert.match(why, /2023-24/);
  assert.match(why, /log loss/);
});

test('the points model is never passed to the engine', async () => {
  const artifact = read('..', 'models', currentEntry(INDEX).file);
  assert.ok(artifact.points, 'the artifact does have a trained points model');
  assert.ok(!artifact.engineConsumes.includes('points'), 'and it declares that the engine must not use it');
  assert.ok(typeof artifact.pointsModelNotConsumedBecause === 'string' && artifact.pointsModelNotConsumedBecause.length > 40);
  assert.equal(selectModel(artifact).model, null, 'nothing at all reaches the engine today');

  // And an artifact that did ask for it would still not get it: this engine has
  // no seam for a points model, so the key is dropped rather than trusted.
  const asked = selectModel({ ...artifact, modelVersion: 'test-1', engineConsumes: ['points', 'startCalibratorJSON'] });
  assert.equal(asked.ok, true);
  assert.deepEqual(asked.consumed, ['startCalibratorJSON']);
  assert.equal(asked.model.points, undefined);
  assert.equal(asked.model.pointsWeights, undefined);
});

// The mechanism is switched off, not removed. A later artifact that declares a
// key this engine has a seam for still gets consumed, with no code change.
test('an artifact that does declare a consumable key is still consumed', () => {
  const status = selectModel({
    modelVersion: 'fpl-planner-v99',
    engineConsumes: ['startCalibratorJSON'],
    startCalibratorJSON: read('..', 'models', currentEntry(INDEX).file).startCalibratorJSON,
  });
  assert.equal(status.ok, true);
  assert.deepEqual(status.consumed, ['startCalibratorJSON']);
  assert.deepEqual(Object.keys(status.model).sort(), ['modelVersion', 'startCalibratorJSON']);
  assert.match(describeModelStatus(status), /start probabilities calibrated/);
});

test('a part the artifact declares but this engine has no seam for is ignored, not trusted', () => {
  const status = selectModel({
    modelVersion: 'test-1',
    engineConsumes: ['startCalibratorJSON', 'somethingFromTheFuture'],
    startCalibratorJSON: { method: 'bins', points: [{ x: 0.1, y: 0.05 }, { x: 0.9, y: 0.95 }] },
    somethingFromTheFuture: { weights: [1, 2, 3] },
  });
  assert.equal(status.ok, true);
  assert.deepEqual(status.consumed, ['startCalibratorJSON']);
  assert.equal(status.model.somethingFromTheFuture, undefined);
});

/* ------------------------------------------------------------ degrading */

test('a malformed artifact falls back with a reason instead of reaching the engine', () => {
  const cases = [
    [null, /not an object/],
    [{ engineConsumes: ['startCalibratorJSON'] }, /no modelVersion/],
    [{ modelVersion: 'test-1' }, /no engineConsumes/],
    [{ modelVersion: 'test-1', engineConsumes: ['startCalibratorJSON'], startCalibratorJSON: { method: 'bins', points: [] } }, /malformed startCalibratorJSON/],
    [{ modelVersion: 'test-1', engineConsumes: ['startCalibratorJSON'], startCalibratorJSON: { method: 'bins', points: [{ x: 'nope', y: 1 }] } }, /malformed startCalibratorJSON/],
    [{ modelVersion: 'test-1', engineConsumes: ['startCalibratorJSON'], startCalibratorJSON: 'not json' }, /malformed startCalibratorJSON/],
  ];
  for (const [artifact, re] of cases) {
    const status = selectModel(artifact);
    assert.equal(status.ok, false);
    assert.equal(status.model, null);
    assert.match(status.reason, re);
  }
});

test('a missing index or a missing artifact file is a fallback, never a throw', async () => {
  const missingIndex = await loadModel({ basePath: 'models/', fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal(missingIndex.ok, false);
  assert.match(missingIndex.reason, /index\.json returned 404/);

  const offline = await loadModel({ basePath: 'models/', fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(offline.ok, false);
  assert.match(offline.reason, /network down/);

  const missingFile = await loadModel({
    basePath: 'models/',
    fetchImpl: async (url) => (String(url).endsWith('index.json')
      ? { ok: true, status: 200, json: async () => INDEX }
      : { ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(missingFile.ok, false);
  assert.match(missingFile.reason, /returned 404/);
});

// Three states, three sentences. "Loaded" and "used" are not the same claim,
// and the panel must not let a reader collapse them.
test('the status panel tells consumed, loaded-but-unused and missing apart', async () => {
  const shipped = await loadModel({ basePath: `${MODELS_DIR}/`, fetchImpl: fileFetch() });
  const unused = describeModelStatus(shipped);
  assert.ok(unused.includes(shipped.modelVersion));
  assert.match(unused, /loaded, not used/);
  assert.match(unused, /replayed/);
  assert.match(unused, /analytic priors/);

  const consumed = describeModelStatus({
    ok: true, modelVersion: 'fpl-planner-v99', consumed: ['startCalibratorJSON'], model: {}, reason: null,
  });
  assert.match(consumed, /^fpl-planner-v99, start probabilities calibrated$/);

  const fallback = describeModelStatus({ ok: false, model: null, modelVersion: null, consumed: [], reason: 'models/index.json returned 404' });
  assert.match(fallback, /not loaded/);
  assert.match(fallback, /404/);
  assert.match(fallback, /analytic priors/);

  assert.equal(describeModelStatus(null), 'not checked');
});

/* --------------------------------------------------- it reaches a real plan */

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
const strength = buildStrength(gameState, { asOfGw: 5 });
const loaded = await loadModel({ basePath: `${MODELS_DIR}/`, fetchImpl: fileFetch() });

// What a future artifact that declares its calibrator would hand over. Built
// from the shipped calibrator so the seam is exercised with real numbers.
const hypothetical = selectModel({
  modelVersion: 'fpl-planner-v99',
  engineConsumes: ['startCalibratorJSON'],
  startCalibratorJSON: read('..', 'models', currentEntry(INDEX).file).startCalibratorJSON,
});

test('projections built with what the loader hands over today are the analytic ones', () => {
  const analytic = buildProjections({ gameState, strength, gwFrom: 6, gwTo: 6 });
  const asShipped = buildProjections({ gameState, strength, gwFrom: 6, gwTo: 6, model: loaded.model });

  assert.equal(asShipped.modelVersion, DEFAULT_MODEL_VERSION, 'no claim that the artifact produced these');
  assert.notEqual(asShipped.modelVersion, loaded.modelVersion);

  for (const [id, rows] of asShipped.byPlayer) {
    const before = analytic.byPlayer.get(id)[0];
    assert.ok(Math.abs(rows[0].pStart - before.pStart) < 1e-12, `player ${id} was touched by a model that is switched off`);
    assert.ok(Math.abs(rows[0].xPoints - before.xPoints) < 1e-12, `player ${id} was touched by a model that is switched off`);
  }
});

test('a consumed calibrator still reaches projections and still moves start probabilities', () => {
  const analytic = buildProjections({ gameState, strength, gwFrom: 6, gwTo: 6 });
  const trained = buildProjections({ gameState, strength, gwFrom: 6, gwTo: 6, model: hypothetical.model });

  assert.equal(trained.modelVersion, 'fpl-planner-v99');

  let moved = 0;
  for (const [id, rows] of trained.byPlayer) {
    const before = analytic.byPlayer.get(id)[0];
    if (Math.abs(rows[0].pStart - before.pStart) > 1e-6) moved++;
  }
  assert.ok(moved > 0, 'the seam is dormant, not dead');
});

test('a plan built the way the app builds it reports the analytic model, not the artifact', async () => {
  // Exactly what js/app.js passes: status.ok is true, status.model is null.
  const asShipped = await buildPlan({
    gameState, squadState, options: { horizon: 3, seed: 7, model: loaded.model },
  });
  assert.equal(asShipped.dataStatus.modelVersion, `planner-1+${DEFAULT_MODEL_VERSION}`);
  assert.equal(asShipped.current.modelVersion, `planner-1+${DEFAULT_MODEL_VERSION}`);
  assert.ok(!asShipped.dataStatus.modelVersion.includes(loaded.modelVersion), 'the plan must not claim the artifact produced it');
  assert.equal(asShipped.validation.ok, true);

  const noModel = await buildPlan({ gameState, squadState, options: { horizon: 3, seed: 7 } });
  assert.equal(noModel.dataStatus.modelVersion, `planner-1+${DEFAULT_MODEL_VERSION}`);
  assert.equal(noModel.validation.ok, true);
});

test('a plan built with a consuming artifact would report that artifact', async () => {
  const trained = await buildPlan({
    gameState, squadState, options: { horizon: 3, seed: 7, model: hypothetical.model },
  });
  assert.equal(trained.dataStatus.modelVersion, 'planner-1+fpl-planner-v99');
  assert.equal(trained.current.modelVersion, 'planner-1+fpl-planner-v99');
  assert.equal(trained.validation.ok, true);
});
