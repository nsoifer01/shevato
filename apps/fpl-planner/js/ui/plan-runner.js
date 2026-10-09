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

// THE WATCHDOG. A worker that hangs, or dies without an `error` event (an
// out-of-memory kill on a phone, a message that cannot be deserialized), used
// to leave the plan on its progress screen forever: nothing ever settled the
// job. Now a job that hears NOTHING from the worker for this long is treated as
// a dead worker: it is terminated and the job falls back to the inline path,
// once, like any other worker failure. The clock restarts on every progress
// message, so it measures silence, not total work. Generous on purpose: a slow
// phone needs 10-18 s of CPU for a whole plan, and the longest silent stretch
// is a fraction of that.
export const WORKER_WATCHDOG_MS = 60000;

export function createPlanRunner({ workerUrl, watchdogMs = WORKER_WATCHDOG_MS } = {}) {
  let worker = null;
  let workerBroken = false;
  // role -> { runId, gameState, bundle }, for the inline whyNot. Same shape and
  // rule as the worker's: one slot per role, a question names its run.
  const inlinePlans = new Map();
  // role -> { runId, gameState, squadState, options } of the last plan the
  // WORKER computed. If the worker then dies, its plan dies with it, and a
  // "why not" about the plan still on screen used to be told "no plan has been
  // computed yet". These inputs let the inline path rebuild that same plan
  // (buildPlan is deterministic for the same inputs and seed) and answer.
  const workerRuns = new Map();
  const pending = new Map();  // id -> { resolve, reject, onProgress, timer }
  let mode = 'unknown';

  // The worker is gone, however it went: every outstanding job is retried
  // inline by its caller, and this runner stops using workers.
  function abandonWorker() {
    workerBroken = true;
    if (worker) {
      try { worker.terminate(); } catch { /* already gone */ }
    }
    worker = null;
    for (const [, job] of pending) {
      clearTimeout(job.timer);
      job.reject(new Error(WORKER_DEAD));
    }
    pending.clear();
  }

  function armWatchdog(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(abandonWorker, watchdogMs);
  }

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
        armWatchdog(job);
        if (job.onProgress) job.onProgress(msg.stage);
        return;
      }
      clearTimeout(job.timer);
      pending.delete(msg.id);
      if (msg.type === 'error') job.reject(new Error(msg.message));
      else if (msg.type === 'plan') job.resolve(msg.bundle);
      else job.resolve(msg.result);
    });
    // A worker-level error means the module never ran (a bad import, or module
    // workers not supported). Every outstanding job is retried inline.
    worker.addEventListener('error', abandonWorker);
    // A reply that could not be deserialized is a job that will never be
    // answered, and the event cannot say which one. Same treatment.
    worker.addEventListener('messageerror', abandonWorker);
    return worker;
  }

  function post(message, onProgress, id = nextId++) {
    const w = ensureWorker();
    if (!w) return Promise.reject(new Error(WORKER_DEAD));
    return new Promise((resolve, reject) => {
      const job = { resolve, reject, onProgress, timer: null };
      pending.set(id, job);
      armWatchdog(job);
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
        workerRuns.set(role, { runId, gameState, squadState, options });
        return { ...bundle, runId };
      } catch (err) {
        if (String(err.message) !== WORKER_DEAD) throw err;
        mode = 'inline';
        workerRuns.delete(role);
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
      let held = inlinePlans.get(role);
      const lost = workerRuns.get(role);
      if (!held && lost) {
        // The worker that computed this plan is gone. Rebuild it here, from
        // the inputs it was given, rather than claim there is no plan.
        if (runId !== null && runId !== lost.runId) throw new Error(STALE_PLAN);
        await runInline({ ...lost, onProgress: null, role });
        workerRuns.delete(role);
        held = inlinePlans.get(role);
      }
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
      for (const [, job] of pending) clearTimeout(job.timer);
      pending.clear();
      inlinePlans.clear();
      workerRuns.clear();
    },
  };
}
