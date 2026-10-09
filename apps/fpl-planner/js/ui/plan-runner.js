// The bridge between the UI and the optimizer.
//
// It hides one decision from every caller: whether the plan was computed in a
// Web Worker or on this thread. Workers are the normal path (see js/worker.js).
// The inline path exists because a module Worker is not universal (older Safari,
// a few embedded browsers, and any page opened from file://), and an app that
// silently does nothing there would be worse than one that briefly janks.
//
// Both paths return the SAME wire-shaped bundle: ProjectionSet without its
// `get()` method, because that is what survives a structured clone and the UI
// must not behave differently depending on how the plan arrived.

import { toWireBundle } from './plan-model.js';
import { STALE_PLAN } from '../engine/plan-basis.js';

let nextId = 1;

const WORKER_DEAD = 'fpl-worker-unavailable';

export function createPlanRunner({ workerUrl } = {}) {
  let worker = null;
  let workerBroken = false;
  // role -> { runId, gameState, bundle }, for the inline whyNot. Same shape and
  // rule as the worker's: one slot per role, a question names its run.
  const inlinePlans = new Map();
  const pending = new Map();  // id -> { resolve, reject, onProgress }
  let mode = 'unknown';

  function ensureWorker() {
    if (workerBroken) return null;
    if (worker) return worker;
    if (typeof Worker === 'undefined') {
      workerBroken = true;
      return null;
    }
    try {
      const url = workerUrl || new URL('../worker.js', import.meta.url);
      worker = new Worker(url, { type: 'module' });
    } catch {
      workerBroken = true;
      return null;
    }
    worker.addEventListener('message', (event) => {
      const msg = event.data || {};
      const job = pending.get(msg.id);
      if (!job) return;
      if (msg.type === 'progress') {
        if (job.onProgress) job.onProgress(msg.stage);
        return;
      }
      pending.delete(msg.id);
      if (msg.type === 'error') job.reject(new Error(msg.message));
      else if (msg.type === 'plan') job.resolve(msg.bundle);
      else job.resolve(msg.result);
    });
    // A worker-level error means the module never ran (a bad import, or module
    // workers not supported). Every outstanding job is retried inline.
    worker.addEventListener('error', () => {
      workerBroken = true;
      try { worker.terminate(); } catch { /* already gone */ }
      worker = null;
      for (const [, job] of pending) job.reject(new Error(WORKER_DEAD));
      pending.clear();
    });
    return worker;
  }

  function post(message, onProgress, id = nextId++) {
    const w = ensureWorker();
    if (!w) return Promise.reject(new Error(WORKER_DEAD));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      w.postMessage({ ...message, id });
    });
  }

  async function runInline({ gameState, squadState, options, onProgress, role, runId }) {
    const { buildPlan } = await import('../engine/planner.js');
    const bundle = await buildPlan({ gameState, squadState, options, onProgress });
    inlinePlans.set(role, { runId, gameState, bundle });
    return { ...toWireBundle(bundle), runId };
  }

  return {
    get mode() { return mode; },

    // `role` keeps the recommendation ('plan') and the sandbox ('scenario')
    // apart; the bundle comes back carrying `runId`, which a "why not"
    // question about it must quote.
    async run({ gameState, squadState, options, onProgress, role = 'plan' }) {
      const runId = nextId++;
      try {
        const bundle = await post({ type: 'plan', gameState, squadState, options, role }, onProgress, runId);
        mode = 'worker';
        inlinePlans.delete(role);
        return { ...bundle, runId };
      } catch (err) {
        if (String(err.message) !== WORKER_DEAD) throw err;
        mode = 'inline';
        return runInline({ gameState, squadState, options, onProgress, role, runId });
      }
    },

    // Answers against the plan of `role`, and only if it is still run `runId`:
    // a question about a plan that has since been replaced is refused with
    // STALE_PLAN rather than answered about the replacement.
    async whyNot(playerId, { runId = null, role = 'plan' } = {}) {
      if (mode === 'worker') {
        try {
          return await post({ type: 'why-not', playerId, role, runId });
        } catch (err) {
          if (String(err.message) !== WORKER_DEAD) throw err;
          mode = 'inline';
        }
      }
      const held = inlinePlans.get(role);
      if (!held) throw new Error('no plan has been computed yet');
      if (runId !== null && runId !== held.runId) throw new Error(STALE_PLAN);
      const { counterfactual } = await import('../engine/counterfactual.js');
      return counterfactual(playerId, {
        planBundle: held.bundle,
        gameState: held.gameState,
        rules: held.gameState.rules,
      });
    },

    dispose() {
      if (worker) {
        try { worker.terminate(); } catch { /* already gone */ }
        worker = null;
      }
      pending.clear();
      inlinePlans.clear();
    },
  };
}
