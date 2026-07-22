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
//   id:<hash>       normalized query -> place ID (or a cached "no match")
//   pd:<placeId>    place ID -> rating payload, short-lived (see tp-places.mjs)
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
