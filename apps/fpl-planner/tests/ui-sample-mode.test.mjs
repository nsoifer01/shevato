import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleSampleBundle, isDemoRequested } from '../js/data/sample.js';
import { createFplApi } from '../js/data/api.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';

// SAMPLE MODE MUST BE DETECTABLE.
//
// The rule this file guards: a plan built from the demo dataset has to be
// distinguishable from a real one by any consumer, without asking how the
// payload was loaded. The flag rides on the bootstrap the sample assembler
// builds, through buildGameState, into dataStatus.sample, which is what every
// visible "Sample data" label is driven from.

const here = dirname(fileURLToPath(import.meta.url));
const readSample = (name) => JSON.parse(readFileSync(join(here, '..', 'data', 'sample', `${name}.json`), 'utf8'));
const readFixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));

const SAMPLE_FILES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const files = Object.fromEntries(SAMPLE_FILES.map(name => [name, readSample(name)]));
const bundle = assembleSampleBundle(files);

test('the sample bundle and the bootstrap it assembles are both labelled', () => {
  assert.equal(bundle.sample, true);
  assert.equal(bundle.bootstrap.sample, true);
});

test('buildGameState carries the sample flag out of the bootstrap', () => {
  const gs = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  assert.equal(gs.sample, true);
});

test('a live-shaped bootstrap produces a game state that is not sample', () => {
  const gs = buildGameState(readFixture('bootstrap'), readFixture('fixtures'), { fetchedAt: '2026-08-10T00:00:00Z' });
  assert.equal(gs.sample, false);
});

test('a plan built from the sample dataset reports dataStatus.sample true', async () => {
  const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  const squadState = buildSquadState({
    entry: bundle.entry, history: bundle.history, transfers: bundle.transfers,
    picks: bundle.picks, gameState, gw: bundle.planEvent,
  });
  const out = await buildPlan({ gameState, squadState, options: { horizon: 2, seed: 7 } });

  assert.equal(out.dataStatus.sample, true, 'the plan must know it came from sample data');
  assert.equal(out.validation.ok, true);
  assert.equal(out.current.gw, bundle.planEvent);
});

test('a plan built from live-shaped data is not marked sample', async () => {
  const gameState = buildGameState(
    { ...readFixture('bootstrap'), events: readFixture('events-in-season') },
    readFixture('fixtures'),
    { fetchedAt: '2026-09-24T10:00:00Z' },
  );
  const squadState = buildSquadState({
    entry: readFixture('entry'), history: readFixture('entry-history'),
    transfers: readFixture('entry-transfers'), picks: readFixture('entry-picks'),
    gameState, gw: 6,
  });
  const out = await buildPlan({ gameState, squadState, options: { horizon: 2, seed: 7 } });
  assert.equal(out.dataStatus.sample, false);
});

test('an explicit options.sample still wins, so the UI can force the label on', async () => {
  const gameState = buildGameState(
    { ...readFixture('bootstrap'), events: readFixture('events-in-season') },
    readFixture('fixtures'),
    { fetchedAt: '2026-09-24T10:00:00Z' },
  );
  const squadState = buildSquadState({
    entry: readFixture('entry'), history: readFixture('entry-history'),
    transfers: readFixture('entry-transfers'), picks: readFixture('entry-picks'),
    gameState, gw: 6,
  });
  const out = await buildPlan({ gameState, squadState, options: { horizon: 2, seed: 7, sample: true } });
  assert.equal(out.dataStatus.sample, true);
});

/* ------------------------------------------------- never a silent fallback */

test('the demo dataset loads only when the URL asks for it', () => {
  assert.equal(isDemoRequested('?demo=1'), true);
  assert.equal(isDemoRequested('?demo=1&view=settings'), true);
  assert.equal(isDemoRequested('?demo=0'), false);
  assert.equal(isDemoRequested('?demo=true'), false);
  assert.equal(isDemoRequested(''), false);
  assert.equal(isDemoRequested('?team=1'), false);
});

test('the client refuses a bundle that is not labelled sample data', () => {
  const api = createFplApi({ fetchImpl: async () => { throw new Error('no network in tests'); }, storage: null });
  assert.throws(() => api.useSampleData({ byPath: { 'bootstrap-static': {} } }), /refusing a bundle that is not labelled sample data/);
  assert.equal(api.isSampleMode(), false);
});

test('a failed live fetch throws rather than quietly serving sample data', async () => {
  const api = createFplApi({
    fetchImpl: async () => { throw new Error('network down'); },
    storage: null,
  });
  await assert.rejects(() => api.getBootstrap(), /network down/);
  assert.equal(api.isSampleMode(), false);
  const status = api.getDataStatus();
  assert.equal(status.sample, false);
  assert.equal(status.sources[0].ok, false);
});

test('once the demo is on, every read is served from the bundle and reported as sample', async () => {
  const api = createFplApi({ fetchImpl: async () => { throw new Error('no network in tests'); }, storage: null });
  api.useSampleData(bundle);
  assert.equal(api.isSampleMode(), true);
  const bootstrap = await api.getBootstrap();
  assert.equal(bootstrap.sample, true);
  assert.equal(bootstrap.data.sample, true);
  assert.equal(api.getDataStatus().sample, true);
});
