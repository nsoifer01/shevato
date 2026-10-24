// The FPL Planner health probe's latest result, for people and monitors.
// 200 when the last scheduled probe passed and ran within the last seven
// hours; 503 when it failed, when no probe has landed for longer than that
// (a scheduler that stops is a failure, not silence), or when a run claimed
// its slot and never stored a result (killed at the 30-second limit). A slot
// deferred past FPL's update after a deadline is shown as `deferred` and
// counts as the scheduler running (lib/fpl-health-run.mjs updateWindowFor).
// Any HTTP monitor can watch this URL; the GitHub backstop
// (.github/workflows/fpl-health.yml) does.
// Read-only and public: it carries invariant names, the values they saw and a
// summary of the plan for a built squad, nothing about any visitor.

import { HEALTH_STORE, openStrongStore, statusOf } from './lib/fpl-health-run.mjs';

export async function handleStatus(request, store, nowMs = Date.now()) {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  const [latest, claim, deferred] = await Promise.all(['latest', 'slot', 'deferred'].map((k) => store.get(k, { type: 'json' })));
  const url = new URL(request.url);
  const { status, body } = statusOf(latest, nowMs, claim, deferred);
  const out = url.searchParams.has('history') ? { ...body, history: (await store.get('history', { type: 'json' })) || [] } : body;
  return new Response(JSON.stringify(out, null, 2), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default async (request) => {
  const { getStore } = await import('@netlify/blobs');
  return handleStatus(request, openStrongStore(getStore, HEALTH_STORE));
};
