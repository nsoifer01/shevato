// The two deletion controls, executed rather than described.
//
// privacy.html makes a narrow, checkable promise about these buttons: that
// "Disconnect your FPL team" removes only the team ID and the cached squad
// snapshot (device and cloud) while saved plans and settings survive, that
// "Delete all FPL Planner data" removes all four keys and the whole
// fplPlannerApp document, and that signed out both remove the local copy only
// and say so. This file runs the shipped click handlers from js/ui/settings.js
// against a fake storage, a fake signed-in session and a stubbed cloud erase,
// and asserts exactly which keys survive each action.
//
// No Firebase session exists in a test run, which is why the cloud half used to
// be a manual check: the erase is intercepted at the module boundary
// (helpers/sync-module-hook.mjs) so the real branch still executes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

register('./helpers/sync-module-hook.mjs', import.meta.url, {
  data: { stubUrl: pathToFileURL(join(here, 'helpers', 'erase-cloud-stub.mjs')).href },
});

const { installDom, fakeStorage, buttonWith, click, query, queryAll, textOf } = await import('./helpers/mini-dom.mjs');
const { settingsView, deletionOutcomeText } = await import('../js/ui/settings.js');
const { KEYS, SYNC_NAMESPACE } = await import('../js/ui/store.js');

const SEED = Object.freeze({
  [KEYS.teamId]: '4231987',
  [KEYS.settings]: JSON.stringify({ horizon: 5, risk: 'aggressive', lastView: 'settings' }),
  [KEYS.planHistory]: JSON.stringify({ 6: [{ version: 1, reason: 'first-calculation', fingerprint: 'fp-1', plan: { gw: 6 } }] }),
  [KEYS.squadSnapshot]: JSON.stringify({ entryId: 4231987, entryName: 'Test FC', picks: [] }),
  // The data layer's cache. The entry keys hold the manager's squad, bank and
  // history under a key that contains the team id, and both buttons must take
  // them (2026-08-22 audit: they survived). The bulk public copy is kept.
  'fpl-planner:cache:entry/4231987': JSON.stringify({ data: { name: 'Test FC' }, fetchedAt: '2026-09-24T10:00:00Z' }),
  'fpl-planner:cache:entry/4231987/history': JSON.stringify({ data: { current: [] }, fetchedAt: '2026-09-24T10:00:00Z' }),
  'fpl-planner:cache:entry/4231987/event/5/picks': JSON.stringify({ data: { picks: [] }, fetchedAt: '2026-09-24T10:00:00Z' }),
  'fpl-planner:cache:bootstrap-static': JSON.stringify({ data: { elements: [] }, fetchedAt: '2026-09-24T10:00:00Z' }),
  // Two keys belonging to other apps. "No other app is touched" is part of the
  // same published promise, so a delete-all that took the whole origin with it
  // has to fail here.
  gymTrackerPrograms: '[{"id":"p1"}]',
  tripPlannerTrips: '[{"id":"t1"}]',
});

// Renders the real settings view with a fake device: fake storage, fake DOM and
// either a signed-in session or none.
function mount({ signedIn = false } = {}) {
  const storage = fakeStorage(SEED);
  const user = signedIn ? { uid: 'user-1', email: 'someone@example.com' } : null;
  const teardown = installDom({
    window: { firebaseAuth: { getCurrentUser: () => user } },
  });
  globalThis.localStorage = storage;
  globalThis.__fplEraseCloudCalls = [];
  globalThis.__fplEraseCloudFailure = null;

  const removals = [];
  const view = settingsView({
    settings: { horizon: 5, risk: 'aggressive', lastView: 'settings' },
    teamId: '4231987',
    squadState: { entryName: 'Test FC' },
    dataStatus: { fetchedAt: '2026-09-24T10:00:00Z' },
    sample: false,
    onApply: () => {},
    onChangeTeam: () => {},
    onDataRemoved: (scope, message) => removals.push({ scope, message }),
    now: Date.parse('2026-09-24T11:00:00Z'),
  });

  return {
    storage,
    view,
    removals,
    cloudCalls: () => globalThis.__fplEraseCloudCalls,
    // Each danger-zone row carries its own status span, so a message has to be
    // read from the row whose button was clicked.
    status: (buttonLabel) => {
      const row = queryAll(view, 'fpl-setting').find((r) => {
        try { return !!buttonWith(r, buttonLabel); } catch { return false; }
      });
      assert.ok(row, `no setting row contains a "${buttonLabel}" button`);
      return query(row, 'fpl-setting-status');
    },
    dispose: () => {
      delete globalThis.localStorage;
      teardown();
    },
  };
}

const surviving = (storage) => Object.keys(storage.snapshot()).sort();
const ENTRY_CACHE = Object.keys(SEED).filter((k) => k.startsWith('fpl-planner:cache:entry/'));
const PUBLIC_CACHE = 'fpl-planner:cache:bootstrap-static';
const KEPT_BY_DISCONNECT = [KEYS.planHistory, KEYS.settings, PUBLIC_CACHE, 'gymTrackerPrograms', 'tripPlannerTrips'].sort();
const KEPT_BY_DELETE_ALL = [PUBLIC_CACHE, 'gymTrackerPrograms', 'tripPlannerTrips'].sort();

test('disconnect removes the team link and the squad snapshot, and nothing else', async () => {
  const app = mount({ signedIn: false });
  try {
    await click(buttonWith(app.view, 'Disconnect FPL team'));

    assert.deepEqual(surviving(app.storage), KEPT_BY_DISCONNECT);
    assert.equal(app.storage.getItem(KEYS.settings), SEED[KEYS.settings], 'settings must survive byte-identical');
    assert.equal(app.storage.getItem(KEYS.planHistory), SEED[KEYS.planHistory], 'saved plans must survive byte-identical');
    // removeItem, not clear(): that is what writes the sync tombstone, so the
    // cloud copy of these two keys goes with the local one. The entry cache
    // keys follow, in storage order.
    assert.deepEqual(app.storage.removed, [KEYS.teamId, KEYS.squadSnapshot, ...ENTRY_CACHE]);
  } finally {
    app.dispose();
  }
});

test('disconnect never deletes the whole cloud document, signed in or out', async () => {
  for (const signedIn of [false, true]) {
    const app = mount({ signedIn });
    try {
      await click(buttonWith(app.view, 'Disconnect FPL team'));
      assert.deepEqual(app.cloudCalls(), [], 'disconnect must not erase the fplPlannerApp document');
      assert.deepEqual(app.storage.removed, [KEYS.teamId, KEYS.squadSnapshot, ...ENTRY_CACHE]);
    } finally {
      app.dispose();
    }
  }
});

test('signed out, disconnect says the local copy is the only one it removed', async () => {
  const app = mount({ signedIn: false });
  try {
    await click(buttonWith(app.view, 'Disconnect FPL team'));
    assert.equal(
      textOf(app.status('Disconnect FPL team')),
      'Your FPL team link was removed from this device. You are not signed in, so there was no copy in a Shevato account to remove.',
    );
    assert.deepEqual(app.removals.map(r => r.scope), ['disconnect']);
  } finally {
    app.dispose();
  }
});

test('signed in, disconnect says both copies went and other devices will follow', async () => {
  const app = mount({ signedIn: true });
  try {
    await click(buttonWith(app.view, 'Disconnect FPL team'));
    assert.equal(
      textOf(app.status('Disconnect FPL team')),
      'Your FPL team link was removed from this device and from your Shevato account. Other devices drop it on their next sync.',
    );
  } finally {
    app.dispose();
  }
});

test('delete-all asks first, and cancelling deletes nothing', async () => {
  const app = mount({ signedIn: true });
  try {
    const confirmBox = query(app.view, 'fpl-confirm');
    assert.equal(confirmBox.hidden, true, 'the confirm box starts hidden');

    await click(buttonWith(app.view, 'Delete FPL Planner data'));
    assert.equal(confirmBox.hidden, false);
    assert.match(textOf(confirmBox), /This deletes all four FPL Planner keys from this device/);
    assert.match(textOf(confirmBox), new RegExp(`deletes the whole ${SYNC_NAMESPACE} document`));

    await click(buttonWith(app.view, 'Cancel'));
    assert.equal(confirmBox.hidden, true);
    assert.deepEqual(app.storage.removed, [], 'cancel removes nothing');
    assert.deepEqual(surviving(app.storage), Object.keys(SEED).sort());
    assert.deepEqual(app.cloudCalls(), []);
  } finally {
    app.dispose();
  }
});

test('signed in, delete-all removes all four keys locally and erases the fplPlannerApp document', async () => {
  const app = mount({ signedIn: true });
  try {
    await click(buttonWith(app.view, 'Delete FPL Planner data'));
    await click(buttonWith(app.view, 'Yes, delete everything'));

    assert.deepEqual(surviving(app.storage), KEPT_BY_DELETE_ALL);
    assert.deepEqual(app.storage.removed, [KEYS.teamId, KEYS.settings, KEYS.planHistory, KEYS.squadSnapshot, ...ENTRY_CACHE]);
    assert.deepEqual(app.cloudCalls(), [SYNC_NAMESPACE], 'exactly one erase, for this app\'s namespace only');
    assert.equal(
      textOf(app.status('Delete FPL Planner data')),
      'All FPL Planner data was removed from this device and from your Shevato account. Other devices drop it on their next sync.',
    );
    assert.equal(query(app.view, 'fpl-confirm').hidden, true, 'the confirm box closes again');
    assert.deepEqual(app.removals.map(r => r.scope), ['delete-all']);
  } finally {
    app.dispose();
  }
});

test('signed out, delete-all clears the device and makes no cloud call', async () => {
  const app = mount({ signedIn: false });
  try {
    await click(buttonWith(app.view, 'Delete FPL Planner data'));
    await click(buttonWith(app.view, 'Yes, delete everything'));

    assert.deepEqual(surviving(app.storage), KEPT_BY_DELETE_ALL);
    assert.deepEqual(app.cloudCalls(), [], 'no session, no cloud copy, no call');
    assert.equal(
      textOf(app.status('Delete FPL Planner data')),
      'All FPL Planner data was removed from this device. You are not signed in, so there was no copy in a Shevato account to remove.',
    );
  } finally {
    app.dispose();
  }
});

test('a failed cloud erase still clears the device and admits the cloud copy is left', async () => {
  const app = mount({ signedIn: true });
  try {
    globalThis.__fplEraseCloudFailure = 'network offline';
    await click(buttonWith(app.view, 'Delete FPL Planner data'));
    await click(buttonWith(app.view, 'Yes, delete everything'));

    assert.deepEqual(surviving(app.storage), KEPT_BY_DELETE_ALL);
    assert.deepEqual(app.cloudCalls(), [SYNC_NAMESPACE]);
    assert.equal(
      textOf(app.status('Delete FPL Planner data')),
      'All FPL Planner data was removed from this device, but the copy in your Shevato account could not be deleted (network offline). Try again while online.',
    );
  } finally {
    app.dispose();
  }
});

test('the outcome sentence always names which of the two copies was removed', () => {
  for (const scope of ['team', 'all']) {
    assert.match(deletionOutcomeText({ scope, signedIn: false }), /not signed in, so there was no copy in a Shevato account/);
    assert.match(deletionOutcomeText({ scope, signedIn: true, cloudOk: true }), /from this device and from your Shevato account/);
    assert.match(deletionOutcomeText({ scope, signedIn: true, cloudOk: false, cloudError: 'boom' }), /could not be deleted \(boom\)/);
  }
  // Only delete-all is allowed to claim it took everything.
  assert.match(deletionOutcomeText({ scope: 'all', signedIn: false }), /^All FPL Planner data/);
  assert.match(deletionOutcomeText({ scope: 'team', signedIn: false }), /^Your FPL team link/);
});

test('privacy.html still describes the behaviour these tests enforce', () => {
  const privacy = readFileSync(join(here, '..', '..', '..', 'privacy.html'), 'utf8');
  assert.match(privacy, /"Disconnect your FPL team" removes only the team ID and the cached squad snapshot, on the device and in the cloud, leaving your saved plans and settings alone/);
  assert.match(privacy, /"Delete all FPL Planner data" removes all four of its keys locally and deletes the whole <code>fplPlannerApp<\/code> document from your account/);
  assert.match(privacy, /Signed out, both remove the local copy only, and the app says which of the two happened/);
});
