// Guards the initAppSync() restart contract.
//
// WHY THIS FILE EXISTS: initAppSync() runs on every delivery of the auth
// state, and firebase-config.js re-fans its listeners whenever ANY other
// shevato tab finishes loading a page, so a user with two tabs open re-enters
// it constantly. It used to call stopAllSyncs() before restarting, which
// cleared the debounced write timer and DELETED the pending queue: an edit
// made in the last 500 ms never reached Firestore, and the older remote copy
// then overwrote it in localStorage and on screen. Tearing down first also
// defeated the same-user shortcut in _startSyncForUser, so every re-entry
// re-attached the listener and re-ran the initial merge.
//
// The BEHAVIOUR half of this guard lives in storage-sync-behavior.test.mjs
// ("restarting a live sync keeps the pending write instead of dropping it"),
// which drives the real engine. What that cannot see is the CALL SITE: the
// engine is idempotent, and initAppSync was throwing that away one line
// earlier. Running app-sync-init.js and the engine together under node --test
// was tried and abandoned: the runner never exits (the module pair leaves the
// loop non-empty and node 20 has no --test-force-exit), and a stub-backed
// version cannot fail, because a stub has no queue to lose. So this is a
// source-shape assertion, deliberately, and it is narrow: it pins the one
// line whose return would reintroduce the bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'app-sync-init.js'), 'utf8');

function bodyOf(fnSignature) {
  const start = source.indexOf(fnSignature);
  assert.notEqual(start, -1, `${fnSignature} not found in app-sync-init.js`);
  // Walk braces from the signature to the matching close.
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${fnSignature}`);
}

test('initAppSync does not stop every sync before restarting', () => {
  const body = bodyOf('export async function initAppSync()');
  const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/\bstopAllSyncs\s*\(/.test(code),
    'initAppSync must not call stopAllSyncs(): it runs on every auth-state '
    + 'delivery, and tearing down first discards the debounced write queue '
    + "(the user's last edit) and defeats the engine's same-user shortcut"
  );
});

test('initAppSync still starts the app and global namespaces', () => {
  const body = bodyOf('export async function initAppSync()');
  assert.ok(/startStorageSync\s*\(/.test(body), 'initAppSync must still start sync');
  assert.ok(/APP_SYNC_CONFIG\[currentApp\]/.test(body), 'it must still resolve the page app');
  assert.ok(/GLOBAL_SYNC_CONFIG/.test(body), 'it must still start the shared-preferences namespace');
});

test('stopAppSync, the sign-out path, does still stop everything', () => {
  // The counterpart. Removing the teardown from initAppSync must not remove
  // it from the place that genuinely wants it.
  const body = bodyOf('export function stopAppSync()');
  assert.ok(/\bstopAllSyncs\s*\(/.test(body), 'stopAppSync must stop every namespace');
});
