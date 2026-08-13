// Coverage for js/ui/plan-runner.js, the bridge that decides whether a plan is
// computed in a Web Worker or on the main thread.
//
// This module had no tests at all, which mattered more than it looks: the
// inline path is the ONLY thing standing between a browser without module
// workers and an app that silently does nothing. The worker path is exercised
// here with a stubbed Worker so the branch logic is real, and the inline path
// is exercised for real against the committed sample dataset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPlanRunner } from '../js/ui/plan-runner.js';
import { assembleSampleBundle } from '../js/data/sample.js';
import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (name) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${name}.json`), 'utf8'));

function realInputs() {
  const bundle = assembleSampleBundle({
    meta: sample('meta'),
    bootstrap: sample('bootstrap'),
    fixtures: sample('fixtures'),
    entry: sample('entry'),
    'entry-history': sample('entry-history'),
    'entry-transfers': sample('entry-transfers'),
    'entry-picks': sample('entry-picks'),
  });
  const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  const squadState = buildSquadState({
    entry: bundle.entry, history: bundle.history, transfers: bundle.transfers,
    picks: bundle.picks, gameState, gw: bundle.planEvent,
  });
  return { gameState, squadState };
}

// A Worker stand-in. `script` decides how it answers a posted message, so each
// test can drive the exact branch it cares about.
function stubWorker(script) {
  const listeners = { message: [], error: [] };
  const instances = [];
  class FakeWorker {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.terminated = false;
      instances.push(this);
    }
    addEventListener(type, fn) { listeners[type].push(fn); }
    postMessage(msg) {
      queueMicrotask(() => script(msg, {
        message: (data) => listeners.message.forEach((f) => f({ data })),
        error: () => listeners.error.forEach((f) => f({})),
      }));
    }
    terminate() { this.terminated = true; }
  }
  return { FakeWorker, instances };
}

function withWorker(FakeWorker, fn) {
  const had = 'Worker' in globalThis;
  const prev = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  return (async () => { try { return await fn(); } finally { if (had) globalThis.Worker = prev; else delete globalThis.Worker; } })();
}

test('with no Worker in the environment it runs inline and still returns a real plan', async () => {
  const had = 'Worker' in globalThis;
  const prev = globalThis.Worker;
  delete globalThis.Worker;
  try {
    const { gameState, squadState } = realInputs();
    const runner = createPlanRunner();
    const stages = [];
    const bundle = await runner.run({ gameState, squadState, options: { seed: 7 }, onProgress: (s) => stages.push(s.key) });
    assert.equal(runner.mode, 'inline');
    assert.ok(bundle.current, 'inline run must still produce a plan');
    assert.equal(bundle.current.startingXI.length, 11);
    assert.deepEqual(stages, ['load-team', 'analyze-players', 'project-fixtures', 'optimize-transfers', 'build-plan']);
    // wire-shaped: the ProjectionSet must have lost its get() to survive cloning
    assert.equal(typeof bundle.projections?.get, 'undefined');
    runner.dispose();
  } finally {
    if (had) globalThis.Worker = prev;
  }
});

test('a Worker constructor that throws falls back to inline rather than failing', async () => {
  class ExplodingWorker { constructor() { throw new Error('module workers unsupported'); } }
  await withWorker(ExplodingWorker, async () => {
    const { gameState, squadState } = realInputs();
    const runner = createPlanRunner();
    const bundle = await runner.run({ gameState, squadState, options: { seed: 7 } });
    assert.equal(runner.mode, 'inline');
    assert.ok(bundle.current.captain);
    runner.dispose();
  });
});

test('a working worker is used, and its progress and result are passed through', async () => {
  const { FakeWorker, instances } = stubWorker((msg, emit) => {
    if (msg.type !== 'plan') return;
    emit.message({ id: msg.id, type: 'progress', stage: { key: 'load-team', label: 'Loading your FPL team' } });
    emit.message({ id: msg.id, type: 'progress', stage: { key: 'build-plan', label: 'Building your Gameweek plan' } });
    emit.message({ id: msg.id, type: 'plan', bundle: { current: { gw: 13, marker: 'from-worker' } } });
  });
  await withWorker(FakeWorker, async () => {
    const runner = createPlanRunner({ workerUrl: 'about:blank' });
    const stages = [];
    const bundle = await runner.run({ gameState: {}, squadState: {}, options: {}, onProgress: (s) => stages.push(s.key) });
    assert.equal(runner.mode, 'worker');
    assert.equal(bundle.current.marker, 'from-worker', 'the worker result must be returned unchanged');
    assert.deepEqual(stages, ['load-team', 'build-plan']);
    assert.equal(instances.length, 1, 'one worker is created and reused');
    runner.dispose();
    assert.equal(instances[0].terminated, true, 'dispose terminates the worker');
  });
});

test('a worker that dies mid-job is retried inline instead of surfacing an error', async () => {
  const { FakeWorker } = stubWorker((msg, emit) => { if (msg.type === 'plan') emit.error(); });
  await withWorker(FakeWorker, async () => {
    const { gameState, squadState } = realInputs();
    const runner = createPlanRunner({ workerUrl: 'about:blank' });
    const bundle = await runner.run({ gameState, squadState, options: { seed: 7 } });
    assert.equal(runner.mode, 'inline', 'a dead worker must degrade, not throw');
    assert.equal(bundle.current.startingXI.length, 11);
    runner.dispose();
  });
});

test('a genuine engine error is surfaced, never swallowed as a worker fallback', async () => {
  const { FakeWorker } = stubWorker((msg, emit) => {
    emit.message({ id: msg.id, type: 'error', message: 'projections blew up' });
  });
  await withWorker(FakeWorker, async () => {
    const runner = createPlanRunner({ workerUrl: 'about:blank' });
    await assert.rejects(
      () => runner.run({ gameState: {}, squadState: {}, options: {} }),
      /projections blew up/,
      'an error from inside the engine must not be mistaken for an unavailable worker',
    );
    runner.dispose();
  });
});

test('whyNot goes through the worker when the plan came from the worker', async () => {
  const seen = [];
  const { FakeWorker } = stubWorker((msg, emit) => {
    seen.push(msg.type);
    if (msg.type === 'plan') emit.message({ id: msg.id, type: 'plan', bundle: { current: {} } });
    else emit.message({ id: msg.id, type: 'result', result: { text: 'because of the club limit' } });
  });
  await withWorker(FakeWorker, async () => {
    const runner = createPlanRunner({ workerUrl: 'about:blank' });
    await runner.run({ gameState: {}, squadState: {}, options: {} });
    const answer = await runner.whyNot(411);
    assert.equal(answer.text, 'because of the club limit');
    assert.deepEqual(seen, ['plan', 'why-not']);
    runner.dispose();
  });
});

test('whyNot before any plan exists fails with a clear message rather than a crash', async () => {
  const had = 'Worker' in globalThis;
  const prev = globalThis.Worker;
  delete globalThis.Worker;
  try {
    const runner = createPlanRunner();
    await assert.rejects(() => runner.whyNot(411), /no plan has been computed yet/);
    runner.dispose();
  } finally {
    if (had) globalThis.Worker = prev;
  }
});

test('whyNot answers inline, from real optimizer output, after an inline plan', async () => {
  const had = 'Worker' in globalThis;
  const prev = globalThis.Worker;
  delete globalThis.Worker;
  try {
    const { gameState, squadState } = realInputs();
    const runner = createPlanRunner();
    const bundle = await runner.run({ gameState, squadState, options: { seed: 7 } });
    const owned = bundle.current.squad[0];
    const answer = await runner.whyNot(owned);
    assert.ok(typeof answer.text === 'string' && answer.text.length > 0, 'why-not must return real text');
    assert.ok('deltaHorizon' in answer, 'and a real horizon delta from the optimizer');
    runner.dispose();
  } finally {
    if (had) globalThis.Worker = prev;
  }
});
