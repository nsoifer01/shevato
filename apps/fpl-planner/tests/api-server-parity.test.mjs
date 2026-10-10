// The browser cache policy and the proxy's, held together.
//
// js/data/api.js says its TTL table "mirrors" netlify/functions/lib/fpl-cache.mjs,
// and both collapse around a deadline with the same numbers. Nothing enforced
// that, and the two are edited in different directories by different rounds:
// the browser sits in FRONT of the proxy, so a browser TTL longer than the
// proxy's means the screen is older than the shared cache behind it, and a
// window one side has and the other lacks is exactly how audit B4 happened.
//
// The browser uses seconds, the proxy milliseconds for its windows; the
// conversion is the only intended difference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../js/data/api.js';
import * as server from '../../../netlify/functions/lib/fpl-cache.mjs';

test('every endpoint class has the same TTL in the browser and the proxy', () => {
  assert.deepEqual(client.CLIENT_TTL, server.TTL);
});

test('the deadline windows and the collapsed TTL are the same numbers on both sides', () => {
  assert.equal(client.DEADLINE_WINDOW_SECONDS * 1000, server.DEADLINE_WINDOW_MS);
  assert.equal(client.POST_DEADLINE_WINDOW_SECONDS * 1000, server.POST_DEADLINE_WINDOW_MS);
  assert.equal(client.DEADLINE_TTL_SECONDS, server.DEADLINE_TTL_SECONDS);
  assert.equal(client.FINISHED_PICKS_TTL_SECONDS, server.FINISHED_PICKS_TTL_SECONDS);
});

test('the browser\'s life for a stale copy is no longer than the proxy will keep serving one', () => {
  // The proxy serves a copy past its TTL for at most STALE_SERVE_SECONDS while
  // one caller refreshes; a browser holding that stale copy longer would
  // outlive the refresh it was waiting for.
  assert.ok(client.STALE_TTL_SECONDS <= server.STALE_SERVE_SECONDS);
});

test('the deadline retry lands inside the proxy\'s collapsed window and outlasts one collapsed TTL', () => {
  // Shorter than the collapsed TTL and two retries could be answered by the
  // same proxy copy; it must fit inside the post-deadline window many times.
  assert.ok(client.DEADLINE_RETRY_MS < server.POST_DEADLINE_WINDOW_MS / 10);
  assert.ok(2 * client.DEADLINE_RETRY_MS > server.DEADLINE_TTL_SECONDS * 1000);
});

test('every path class the proxy allows is one the browser can label', () => {
  const samples = {
    bootstrap: 'bootstrap-static', fixtures: 'fixtures', entry: 'entry/7/history',
    'element-summary': 'element-summary/3', live: 'event/6/live', 'event-status': 'event-status',
  };
  assert.deepEqual(Object.keys(samples).sort(), [...new Set(server.ALLOWED_PATHS.map(p => p.kind))].sort());
  for (const path of Object.values(samples)) {
    assert.equal(server.canonicalPath(path), path);
    assert.notEqual(client.labelFor(path), path, `${path} has a human label`);
  }
});
