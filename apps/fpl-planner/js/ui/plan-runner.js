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

let nextId = 1;

const WORKER_DEAD = 'fpl-worker-unavailable';

export function createPlanRunner({ workerUrl } = {}) {
  let worker = null;
  let workerBroken = false;
  let inline = null;          // { gameState, bundle } for the inline whyNot
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

  function post(message, onProgress) {
    const w = ensureWorker();
    if (!w) return Promise.reject(new Error(WORKER_DEAD));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      w.postMessage({ ...message, id });
    });
  }

  async function runInline({ gameState, squadState, options, onProgress }) {
    const { buildPlan } = await import('../engine/planner.js');
    const bundle = await buildPlan({ gameState, squadState, options, onProgress });
    inline = { gameState, bundle };
    return toWireBundle(bundle);
  }

  return {
    get mode() { return mode; },

    async run({ gameState, squadState, options, onProgress }) {
      try {
        const bundle = await post({ type: 'plan', gameState, squadState, options }, onProgress);
        mode = 'worker';
        inline = null;
        return bundle;
      } catch (err) {
        if (String(err.message) !== WORKER_DEAD) throw err;
        mode = 'inline';
        return runInline({ gameState, squadState, options, onProgress });
      }
    },

    async whyNot(playerId) {
      if (mode === 'worker') {
        try {
          return await post({ type: 'why-not', playerId });
        } catch (err) {
          if (String(err.message) !== WORKER_DEAD) throw err;
          mode = 'inline';
        }
      }
      if (!inline) throw new Error('no plan has been computed yet');
      const { counterfactual } = await import('../engine/counterfactual.js');
      return counterfactual(playerId, {
        planBundle: inline.bundle,
        gameState: inline.gameState,
        rules: inline.gameState.rules,
      });
    },

    dispose() {
      if (worker) {
        try { worker.terminate(); } catch { /* already gone */ }
        worker = null;
      }
      pending.clear();
      inline = null;
    },
  };
}
