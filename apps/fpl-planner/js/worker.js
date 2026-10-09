// Plan computation, off the main thread.
//
// WHY: a full run is hundreds of milliseconds of tight numeric work (projecting
// every player over the horizon, enumerating every legal formation for every
// candidate squad, searching transfers). On the main thread that is a frozen
// page: no countdown tick, no scroll, no cancel. Here the UI stays live and can
// paint the five real progress stages the planner emits as it passes them.
//
// The main thread owns the network and the normalization (bootstrap -> GameState,
// entry -> SquadState) and posts those two objects in. Structured clone keeps
// Maps, so the worker gets the same GameState the UI is rendering from.
//
// The trained model artifact rides in with `options.model`, loaded once on the
// main thread by js/data/model.js. It is plain JSON, so it clones, and this is
// where it has to arrive: the projections that consume it are built inside
// buildPlan, here, not on the page. When it is absent buildPlan falls back to
// the analytic priors and reports that in dataStatus.modelVersion.
//
// One thing does NOT survive structured clone: a function. ProjectionSet carries
// a `get()` convenience method, so the bundle is stripped before it is posted
// back (the UI reads `byPlayer` through ui/plan-model.js). The unstripped bundle
// stays here, which is also why "Why not <player>?" is answered in the worker:
// counterfactual() re-runs real optimization, including a whole squad rebuild
// with the requested player locked in, and needs the live ProjectionSet.

import { buildPlan } from './engine/planner.js';
import { counterfactual } from './engine/counterfactual.js';
import { toWireBundle } from './ui/plan-model.js';
import { STALE_PLAN } from './engine/plan-basis.js';

// The plans this worker holds, by role: the recommendation the page shows
// ('plan') and the team sandbox's hypothetical ('scenario'). One slot used to
// hold whichever ran last, so asking "why not?" after trying a scenario
// answered against the SCENARIO's plan under the real one. Each slot keeps the
// id of the run that filled it, and a question names the run it is about.
const plans = new Map();

self.addEventListener('message', async (event) => {
  const msg = event.data || {};

  if (msg.type === 'plan') {
    try {
      const bundle = await buildPlan({
        gameState: msg.gameState,
        squadState: msg.squadState,
        options: msg.options || {},
        onProgress: (stage) => self.postMessage({ type: 'progress', id: msg.id, stage }),
      });
      plans.set(msg.role || 'plan', { runId: msg.id, gameState: msg.gameState, bundle });
      self.postMessage({ type: 'plan', id: msg.id, bundle: toWireBundle(bundle) });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
    return;
  }

  if (msg.type === 'why-not') {
    try {
      const held = plans.get(msg.role || 'plan');
      if (!held) throw new Error('no plan has been computed yet');
      if (msg.runId !== undefined && msg.runId !== null && msg.runId !== held.runId) throw new Error(STALE_PLAN);
      const result = counterfactual(msg.playerId, {
        planBundle: held.bundle,
        gameState: held.gameState,
        rules: held.gameState.rules,
      });
      self.postMessage({ type: 'why-not', id: msg.id, result });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
  }
});
