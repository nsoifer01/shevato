// Daily clean-up of the FPL proxy's per-manager cache keys.
//
// WHY. `fpl.mjs` caches every allowlisted FPL response in the site-scoped
// `fpl-planner` blob store, and nothing ever deleted a key: every team id ever
// looked up left `v1:entry__<id>...` keys (entry, history, transfers, one picks
// key per gameweek viewed) and a `lease:` key per cache key, for good (root
// FINDINGS, "Old deploys run old function code against the live blobs";
// apps/fpl-planner FINDINGS, the 2026-10-09 audit). They are caches of PUBLIC
// FPL data, re-fetched on demand, never history: the deadline archive
// (apps/fpl-planner/scripts/archive-snapshot.mjs) is where history lives.
//
// WHAT IS DELETED, and nothing else:
//   - a `v1:entry__...` key whose copy was fetched more than ENTRY_MAX_AGE_DAYS
//     ago. The longest TTL any of them has is a day (finished-gameweek picks),
//     so such a copy is never served fresh again; its only remaining use is the
//     stale fallback while FPL is down, which a fortnight-old copy of one
//     manager's team is not worth keeping for.
//   - a `lease:` key whose lease expired more than LEASE_MAX_AGE_HOURS ago (a
//     lease lives 20 seconds).
// Shared keys (`v1:bootstrap-static`, `v1:fixtures`, `v1:event__...`,
// `v1:element-summary__...`), the deadline meta and the quota counters are
// never touched: they are bounded in number and refreshed constantly.
//
// COST: one scheduled invocation a day on the free tier, a list and a read per
// candidate key. A run deletes at most MAX_DELETES_PER_RUN keys so a first run
// over a large backlog cannot exceed the function's time limit; the rest go
// on the following days.

import { STORE_NAME } from './lib/fpl-cache.mjs';

export const PRUNE = Object.freeze({
  entryPrefix: 'v1:entry__',
  leasePrefix: 'lease:',
  entryMaxAgeDays: 14,
  leaseMaxAgeHours: 1,
  maxDeletesPerRun: 2000,
});

async function listKeys(store, prefix) {
  const out = await store.list({ prefix });
  return ((out && out.blobs) || []).map((b) => b.key);
}

/**
 * Delete stale per-manager cache keys and expired leases. Pure apart from the
 * store, so tests drive it with an in-memory store and a fixed clock.
 * @returns {Promise<{ scanned: number, deleted: number, kept: number, unreadable: number, capped: boolean }>}
 */
export async function pruneFplCache(store, { now = Date.now(), limits = PRUNE } = {}) {
  const entryCutoff = now - limits.entryMaxAgeDays * 86400e3;
  const leaseCutoff = now - limits.leaseMaxAgeHours * 3600e3;
  const stats = { scanned: 0, deleted: 0, kept: 0, unreadable: 0, capped: false };

  const candidates = [
    ...(await listKeys(store, limits.entryPrefix)).map((key) => ({ key, kind: 'entry' })),
    ...(await listKeys(store, limits.leasePrefix)).map((key) => ({ key, kind: 'lease' })),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  for (const c of candidates) {
    if (stats.deleted >= limits.maxDeletesPerRun) { stats.capped = true; break; }
    stats.scanned++;
    let value;
    try {
      value = await store.get(c.key, { type: 'json' });
    } catch {
      stats.unreadable++;
      continue;
    }
    if (!value || typeof value !== 'object') { stats.unreadable++; continue; }
    const stale = c.kind === 'entry'
      ? Number.isFinite(Date.parse(value.fetchedAt)) && Date.parse(value.fetchedAt) < entryCutoff
      : Number.isFinite(Number(value.expiresAt)) && Number(value.expiresAt) < leaseCutoff;
    if (!stale) { stats.kept++; continue; }
    await store.delete(c.key);
    stats.deleted++;
  }
  return stats;
}

export default async () => {
  const { getStore } = await import('@netlify/blobs');
  const stats = await pruneFplCache(getStore(STORE_NAME));
  console.log('fpl-cache-prune', JSON.stringify(stats));
  return new Response(JSON.stringify(stats), { status: 200, headers: { 'content-type': 'application/json' } });
};

// Netlify scheduled function: once a day, at a quiet hour for UK football.
export const config = { schedule: '0 4 * * *' };
