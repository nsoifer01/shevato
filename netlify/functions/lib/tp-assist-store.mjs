// Blob store for the Trip Planner site assistant (Tier 3).
//
// This site does not inject env vars into functions, so the shared Gemini key
// lives in the `config` blob, written once out-of-band (never over HTTP):
//   netlify blobs:set trip-planner-assist config '{"geminiKey":"<key>"}'
// Disable the shared assistant again with:
//   netlify blobs:set trip-planner-assist config '{}'
// The store is per-project: run `netlify status` first and confirm the CLI is
// linked to the project that serves shevato.com, or the write lands in a store
// this function never reads.
//
// The `usage` blob holds the rolling rate-limit counters (see tp-assist-quota).
// Neither blob is ever served to the browser.

import { getStore } from '@netlify/blobs';

export const STORE_NAME = 'trip-planner-assist';
export const CONFIG_KEY = 'config';
export const USAGE_KEY = 'usage';

export function assistStore() {
  return getStore(STORE_NAME);
}
