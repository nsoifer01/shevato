// The FPL Planner health probe's latest result, for people and monitors.
// 200 when the last scheduled probe passed and ran within the last seven
// hours; 503 when it failed, or when no probe has landed for longer than that
// (a scheduler that stops is a failure, not silence). Any HTTP monitor can
// watch this URL; the GitHub backstop (.github/workflows/fpl-health.yml) does.
// Read-only and public: it carries invariant names, the values they saw and a
// summary of the plan for a built squad, nothing about any visitor.

import { HEALTH_STORE, statusOf } from './lib/fpl-health-run.mjs';

export async function handleStatus(request, store, nowMs = Date.now()) {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  const latest = await store.get('latest', { type: 'json' });
  const url = new URL(request.url);
  const { status, body } = statusOf(latest, nowMs);
  const out = url.searchParams.has('history') ? { ...body, history: (await store.get('history', { type: 'json' })) || [] } : body;
  return new Response(JSON.stringify(out, null, 2), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export default async (request) => {
  const { getStore } = await import('@netlify/blobs');
  return handleStatus(request, getStore(HEALTH_STORE));
};
