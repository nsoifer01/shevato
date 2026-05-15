// Structural tests for storage-sync-robust.js.
//
// The module pulls Firebase from a gstatic.com URL so Node cannot
// import it directly. We assert the file's *shape* instead — every
// invariant the consolidation work introduced has an unmistakable
// textual marker, and these tests fail loudly if anyone later
// reverts the wiring without realising what they're undoing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SYNC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(SYNC_DIR, 'storage-sync-robust.js'), 'utf8');

test('storage-sync-robust imports the cross-tab channel module', () => {
    assert.match(SRC, /from\s+['"]\.\/cross-tab-channel\.mjs['"]/);
    assert.match(SRC, /createCrossTabChannel/);
    assert.match(SRC, /CHANNEL_MESSAGE_TYPES/);
});

test('storage-sync-robust imports pure helpers from sync-helpers', () => {
    assert.match(SRC, /from\s+['"]\.\/sync-helpers\.mjs['"]/);
    for (const fn of ['hashValue', 'parseValue', 'getTimestamp', 'sanitiseForFirestore', 'estimatePayloadBytes', 'sameKeySet', 'decideRemoteChange']) {
        assert.match(SRC, new RegExp(`\\b${fn}\\b`), `expected ${fn} to be referenced`);
    }
});

test('storage-sync-robust installs a visibility-change listener', () => {
    assert.match(SRC, /visibilitychange/);
    assert.match(SRC, /visibilityState/);
    assert.match(SRC, /handleTabVisible|reconcileFromLocalStorage/);
});

test('storage-sync-robust subscribes to peer DATA_UPDATED broadcasts', () => {
    // Must subscribe to peer-tab notifications and route them into the
    // reconcile path so a stale onSnapshot can still surface fresh data.
    assert.match(SRC, /subscribe\([^,]*DATA_UPDATED[\s\S]*?onCrossTabDataUpdated|onCrossTabDataUpdated[\s\S]*?subscribe/);
    assert.match(SRC, /reconcileFromLocalStorage/);
});

test('storage-sync-robust publishes DATA_UPDATED after a successful flush', () => {
    // The publish must come from inside the success branch — i.e. AFTER
    // the awaited flush call, BEFORE the catch block.
    assert.match(SRC, /channel\.publish\(\s*CHANNEL_MESSAGE_TYPES\.DATA_UPDATED/);
});

test('storage-sync-robust exports eraseCloudData so apps stop importing Firestore directly', () => {
    assert.match(SRC, /export\s+async\s+function\s+eraseCloudData/);
});

test('storage-sync-robust still exports the original public API', () => {
    for (const fn of ['startStorageSync', 'stopAllSyncs', 'setCloudItem', 'getSyncStatus', 'getGlobalSyncStatus']) {
        assert.match(SRC, new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`), `expected ${fn} to remain exported`);
    }
});

test('storage-sync-robust source ships no stale references to the retired persistence shim', () => {
    assert.doesNotMatch(SRC, /firebase-persistence/);
});

test('storage-sync-robust uses onSnapshot (not getDoc) for the live listener', () => {
    assert.match(SRC, /\bonSnapshot\b/);
    // includeMetadataChanges is what lets us detect cache→server transitions
    // so the initial-merge guard doesn't fire against a stale cached snapshot.
    assert.match(SRC, /includeMetadataChanges/);
});

test('storage-sync-robust has a retry loop with exponential backoff', () => {
    assert.match(SRC, /MAX_RETRY_ATTEMPTS/);
    assert.match(SRC, /retryAttempts/);
    assert.match(SRC, /Math\.pow\(2/);
});

test('storage-sync-robust gates the initial merge on the snapshot being server-confirmed', () => {
    // The cross-browser data-loss bug we patched was: a cached snapshot
    // looking empty caused us to upload local-only keys before the server
    // snapshot delivered. Gate must be on !fromCache.
    assert.match(SRC, /initialMergeDone/);
    assert.match(SRC, /fromCache/);
});

test('storage-sync-robust refuses oversized flushes', () => {
    assert.match(SRC, /MAX_FLUSH_BYTES/);
    assert.match(SRC, /exceeds/);
});
