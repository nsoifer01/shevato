// Blob store for the Trip Planner Google-ratings lookup (tp-places).
//
// Deliberately a SEPARATE store from `trip-planner-assist`: the Gemini key and
// the Places key have different blast radii (Places is billed per call against
// a card) and must be rotatable, or revocable, one without the other.
//
// OWNER SETUP (one-time, out-of-band; env vars are NOT injected into functions
// on this site, so the key lives in a Blob):
//   netlify blobs:set trip-planner-places config '{"placesKey":"<key>"}'
// Disable ratings again with:
//   netlify blobs:set trip-planner-places config '{}'
// The store is per-project: run `netlify status` first and confirm the CLI is
// linked to the project that serves shevato.com, or the write lands in a store
// this function never reads.
//
// Keys in this store:
//   config          the Places API key, plus the optional ownerToken secret
//                   for the owner quota tier (neither ever served to the
//                   browser)
//   usage           rolling quota counters (see tp-places-quota.mjs)
//   id:<hash>       normalized query + area -> the place ID it resolved to (or
//                   a cached "no match"), plus any verdicts the gates reached
//                   about that candidate. See tp-places-lookup.mjs for the
//                   shape and the TTLs.
// There is deliberately NO key holding a rating, a name, an address or an hours
// line, and there must never be one: Google's terms permit the place ID
// indefinitely (SST A.3) and lat/lng for 30 days (SST 14.3) and grant nothing
// else for Places. A `pd:<placeId>` details cache used to live here; the writer
// was removed on 2026-08-13 and 201 stale blobs had to be purged from the
// production store separately on 2026-08-17. Removing a cache is two jobs.
// Cache entries are per-key rather than one big object so two concurrent
// batches cannot clobber each other's writes.

import { getStore } from '@netlify/blobs';

export const STORE_NAME = 'trip-planner-places';
export const CONFIG_KEY = 'config';
export const USAGE_KEY = 'usage';

export function placesStore() {
  return getStore(STORE_NAME);
}

// A tiny adapter so the lookup pipeline (tp-places-lookup.mjs) can be unit
// tested against an in-memory map instead of a live Blobs context.
export function blobCache(store) {
  return {
    async get(key) {
      return (await store.get(key, { type: 'json' })) || null;
    },
    async set(key, entry) {
      await store.setJSON(key, entry);
    },
  };
}
