// Blob store for the Trip Planner site assistant (Tier 3).
//
// This site does not inject env vars into functions, so the shared Gemini key
// lives in the `config` blob, written once out-of-band (never over HTTP):
//   netlify blobs:set trip-planner-assist config '{"geminiKey":"<key>"}' --json
// Disable the shared assistant again with:
//   netlify blobs:set trip-planner-assist config '{}' --json
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
