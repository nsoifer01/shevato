'use strict';

// Unit tests for the rival-network pure core (js/network.js). No dates and no
// Firebase here on purpose: every function below is a deterministic transform
// of plain objects, which is exactly why they live outside app.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_NAME_LEN, MAX_HANDLE_LEN, MAX_PUBLISHED_RIVALS,
  normalizeHandle, handleKey, pairKey,
  buildNetworkDoc, mergeIncomingLinks, buildDiscoveryList,
} = require('../js/network.js');

// Local rival shape as app.js stores it.
const rival = (id, name, maptapUsername, icon = '🦊') =>
  ({ id, name, maptapUsername, icon, color: '#6366f1', createdAt: 1 });

// --- pairKey --------------------------------------------------------------

test('pairKey sorts the two uids so both sides derive the same doc id', () => {
  assert.equal(pairKey('bbb', 'aaa'), 'aaa__bbb');
  assert.equal(pairKey('aaa', 'bbb'), 'aaa__bbb');
});

test('pairKey ordering is lexicographic, not insertion or length based', () => {
  assert.equal(pairKey('z1', 'a99999'), 'a99999__z1');
  assert.equal(pairKey('B', 'a'), 'B__a'); // uppercase sorts before lowercase
});

test('pairKey refuses non-pairs: same uid, empty, null, whitespace', () => {
  assert.equal(pairKey('same', 'same'), null);
  assert.equal(pairKey('', 'aaa'), null);
  assert.equal(pairKey('aaa', ''), null);
  assert.equal(pairKey(null, 'aaa'), null);
  assert.equal(pairKey('aaa', undefined), null);
  assert.equal(pairKey('   ', 'aaa'), null);
});

test('pairKey trims so a stray space cannot fork a second doc for one pair', () => {
  assert.equal(pairKey(' aaa ', 'bbb'), 'aaa__bbb');
});

// --- handleKey / normalizeHandle -----------------------------------------

test('handleKey accepts a full maptap.gg profile URL', () => {
  assert.equal(handleKey('https://maptap.gg/u/SusMaBit'), 'susmabit');
  assert.equal(handleKey('maptap.gg/u/dean?tab=history'), 'dean');
});

test('handleKey accepts the @handle and bare forms', () => {
  assert.equal(handleKey('@Dean'), 'dean');
  assert.equal(handleKey('  Dean  '), 'dean');
});

test('handleKey is case-insensitive so one person claims exactly one doc id', () => {
  assert.equal(handleKey('DEAN'), handleKey('dean'));
  assert.equal(handleKey('https://maptap.gg/u/DEAN'), handleKey('@dean'));
});

test('handleKey returns empty for missing input', () => {
  assert.equal(handleKey(''), '');
  assert.equal(handleKey(null), '');
  assert.equal(handleKey(undefined), '');
  assert.equal(handleKey('   '), '');
});

test('handleKey rejects ids Firestore cannot address (slashes, . and ..)', () => {
  assert.equal(handleKey('a/b'), '');
  assert.equal(handleKey('a\\b'), '');
  assert.equal(handleKey('.'), '');
  assert.equal(handleKey('..'), '');
});

test('normalizeHandle keeps display case while handleKey lowercases it', () => {
  assert.equal(normalizeHandle('https://maptap.gg/u/SusMaBit'), 'SusMaBit');
  assert.equal(handleKey('https://maptap.gg/u/SusMaBit'), 'susmabit');
});

test('normalizeHandle caps absurdly long input at the handle limit', () => {
  const long = 'x'.repeat(500);
  assert.equal(normalizeHandle(long).length, MAX_HANDLE_LEN);
});

// --- buildNetworkDoc ------------------------------------------------------

test('buildNetworkDoc publishes handle, name, icon and rival handles only', () => {
  const doc = buildNetworkDoc({
    handle: 'susmabit',
    name: 'Nikita',
    icon: '🧍',
    rivals: [rival('r1', 'Dean', 'dean', '🐺')],
  });
  assert.deepEqual(doc, {
    handle: 'susmabit',
    name: 'Nikita',
    icon: '🧍',
    rivals: [{ handle: 'dean', name: 'Dean', icon: '🐺' }],
  });
});

test('buildNetworkDoc never leaks local ids, colors, timestamps or games', () => {
  const doc = buildNetworkDoc({
    handle: 'susmabit',
    name: 'Nikita',
    icon: '🧍',
    rivals: [rival('local-id-1', 'Dean', 'dean')],
  });
  const json = JSON.stringify(doc);
  assert.equal(json.includes('local-id-1'), false);
  assert.equal(json.includes('#6366f1'), false);
  assert.equal(json.includes('createdAt'), false);
  assert.deepEqual(Object.keys(doc.rivals[0]).sort(), ['handle', 'icon', 'name']);
});

test('buildNetworkDoc drops rivals that have no maptap handle', () => {
  const doc = buildNetworkDoc({
    handle: 'susmabit',
    name: 'Nikita',
    rivals: [
      rival('r1', 'Dean', 'dean'),
      rival('r2', 'Offline Friend', ''),
      rival('r3', 'No Handle', null),
    ],
  });
  assert.deepEqual(doc.rivals.map(r => r.handle), ['dean']);
});

test('buildNetworkDoc dedupes rivals by handleKey, keeping the first entry', () => {
  const doc = buildNetworkDoc({
    handle: 'susmabit',
    name: 'Nikita',
    rivals: [
      rival('r1', 'Dean', 'Dean'),
      rival('r2', 'Dean duplicate', 'https://maptap.gg/u/DEAN'),
      rival('r3', 'Bea', '@bea'),
    ],
  });
  assert.deepEqual(doc.rivals.map(r => r.name), ['Dean', 'Bea']);
});

test('buildNetworkDoc never publishes my own handle inside my rival list', () => {
  const doc = buildNetworkDoc({
    handle: 'SusMaBit',
    name: 'Nikita',
    rivals: [rival('r1', 'Me again', 'susmabit'), rival('r2', 'Dean', 'dean')],
  });
  assert.deepEqual(doc.rivals.map(r => r.handle), ['dean']);
});

test('buildNetworkDoc caps names so one member cannot bloat the shared doc', () => {
  const doc = buildNetworkDoc({
    handle: 'susmabit',
    name: 'N'.repeat(300),
    rivals: [rival('r1', 'D'.repeat(300), 'dean')],
  });
  assert.equal(doc.name.length, MAX_NAME_LEN);
  assert.equal(doc.rivals[0].name.length, MAX_NAME_LEN);
});

test('buildNetworkDoc caps the published rival count', () => {
  const many = [];
  for (let i = 0; i < MAX_PUBLISHED_RIVALS + 25; i++) {
    many.push(rival('r' + i, 'R' + i, 'handle' + i));
  }
  const doc = buildNetworkDoc({ handle: 'susmabit', name: 'Nikita', rivals: many });
  assert.equal(doc.rivals.length, MAX_PUBLISHED_RIVALS);
});

test('buildNetworkDoc falls back to the handle when a name is blank', () => {
  const doc = buildNetworkDoc({
    handle: 'susmabit',
    name: '   ',
    rivals: [rival('r1', '', 'dean')],
  });
  assert.equal(doc.name, 'susmabit');
  assert.equal(doc.rivals[0].name, 'dean');
});

test('buildNetworkDoc returns null without a usable handle (join is impossible)', () => {
  assert.equal(buildNetworkDoc(null), null);
  assert.equal(buildNetworkDoc({ handle: '', name: 'Nikita' }), null);
  assert.equal(buildNetworkDoc({ handle: 'a/b', name: 'Nikita' }), null);
});

test('buildNetworkDoc also sanitizes a peer doc read back from Firestore', () => {
  // Read side: rivals arrive as { handle, name, icon }, not as local rivals.
  const doc = buildNetworkDoc({
    handle: 'dean',
    name: 'Dean',
    icon: '🐺',
    rivals: [
      { handle: 'bea', name: 'Bea', icon: '🐻' },
      { handle: 'bea', name: 'Bea dupe', icon: '🐻' },
      { name: 'handleless', icon: '👻' },
    ],
  });
  assert.deepEqual(doc.rivals, [{ handle: 'bea', name: 'Bea', icon: '🐻' }]);
});

// --- mergeIncomingLinks ---------------------------------------------------

const LINK = {
  pairKey: 'me__peer',
  uids: ['me', 'peer'],
  handles: { me: 'susmabit', peer: 'dean' },
  names: { me: 'Nikita', peer: 'Dean' },
};
const DIR = { peer: { handle: 'Dean', name: 'Dean', icon: '🐺', rivals: [] } };

test('mergeIncomingLinks queues a peer with no matching local rival', () => {
  const { toAdd, linkedRivalIds } = mergeIncomingLinks([], [LINK], 'me', DIR);
  assert.equal(linkedRivalIds.size, 0);
  assert.equal(toAdd.length, 1);
  assert.deepEqual(toAdd[0], {
    pairKey: 'me__peer',
    peerUid: 'peer',
    handle: 'Dean',
    name: 'Dean',
    icon: '🐺',
  });
});

test('mergeIncomingLinks marks an existing rival connected instead of adding', () => {
  const mine = [rival('r1', 'Dean', 'dean')];
  const { toAdd, linkedRivalIds } = mergeIncomingLinks(mine, [LINK], 'me', DIR);
  assert.deepEqual(toAdd, []);
  assert.equal(linkedRivalIds.get('r1'), 'me__peer');
});

test('mergeIncomingLinks matches by handleKey, not by exact stored string', () => {
  const mine = [rival('r1', 'Dean', 'https://maptap.gg/u/DEAN')];
  const { toAdd, linkedRivalIds } = mergeIncomingLinks(mine, [LINK], 'me', DIR);
  assert.deepEqual(toAdd, []);
  assert.equal(linkedRivalIds.get('r1'), 'me__peer');
});

test('mergeIncomingLinks is idempotent: materializing a draft stops the re-add', () => {
  const mine = [];
  const first = mergeIncomingLinks(mine, [LINK], 'me', DIR);
  assert.equal(first.toAdd.length, 1);
  // app.js materializes the draft exactly as the UI does.
  mine.push(rival('new-1', first.toAdd[0].name, first.toAdd[0].handle));
  const second = mergeIncomingLinks(mine, [LINK], 'me', DIR);
  assert.deepEqual(second.toAdd, []);
  assert.equal(second.linkedRivalIds.get('new-1'), 'me__peer');
});

test('mergeIncomingLinks honors skipPairKeys so a deleted auto-add stays deleted', () => {
  const { toAdd } = mergeIncomingLinks([], [LINK], 'me', DIR, { skipPairKeys: ['me__peer'] });
  assert.deepEqual(toAdd, []);
});

test('mergeIncomingLinks never queues the same peer twice within one pass', () => {
  const dupLink = { ...LINK, pairKey: 'me__peer2', uids: ['me', 'peer2'], handles: { me: 'susmabit', peer2: 'dean' } };
  const dir = { ...DIR, peer2: { handle: 'dean', name: 'Dean again', icon: '🐺' } };
  const { toAdd } = mergeIncomingLinks([], [LINK, dupLink], 'me', dir);
  assert.equal(toAdd.length, 1);
  assert.equal(toAdd[0].pairKey, 'me__peer');
});

test('mergeIncomingLinks falls back to the link handle when no directory entry exists', () => {
  const { toAdd } = mergeIncomingLinks([], [LINK], 'me', {});
  assert.equal(toAdd.length, 1);
  assert.equal(toAdd[0].handle, 'dean');
  assert.equal(toAdd[0].name, 'Dean'); // from link.names
});

test('mergeIncomingLinks names an unnamed peer after their handle', () => {
  const bare = { pairKey: 'me__peer', uids: ['me', 'peer'], handles: { peer: 'dean' } };
  const { toAdd } = mergeIncomingLinks([], [bare], 'me', {});
  assert.equal(toAdd[0].name, 'dean');
  assert.equal(toAdd[0].icon, '');
});

test('mergeIncomingLinks skips links with no resolvable peer handle', () => {
  const noHandle = { pairKey: 'me__peer', uids: ['me', 'peer'] };
  const { toAdd, linkedRivalIds } = mergeIncomingLinks([], [noHandle], 'me', {});
  assert.deepEqual(toAdd, []);
  assert.equal(linkedRivalIds.size, 0);
});

test('mergeIncomingLinks ignores links that do not contain my uid', () => {
  const foreign = { pairKey: 'a__b', uids: ['a', 'b'], handles: { a: 'x', b: 'y' } };
  const { toAdd } = mergeIncomingLinks([], [foreign], 'me', {});
  assert.deepEqual(toAdd, []);
});

test('mergeIncomingLinks derives a pairKey when the link doc id is missing', () => {
  const noKey = { uids: ['me', 'peer'], handles: { peer: 'dean' } };
  const { toAdd } = mergeIncomingLinks([], [noKey], 'me', {});
  assert.equal(toAdd[0].pairKey, 'me__peer');
});

test('mergeIncomingLinks returns empty state for missing uid or junk input', () => {
  assert.deepEqual(mergeIncomingLinks([], [LINK], '', DIR).toAdd, []);
  assert.deepEqual(mergeIncomingLinks(null, null, 'me', null).toAdd, []);
  assert.deepEqual(mergeIncomingLinks([null], [null], 'me', {}).toAdd, []);
});

test('mergeIncomingLinks connects several rivals at once', () => {
  const links = [
    LINK,
    { pairKey: 'me__peer2', uids: ['me', 'peer2'], handles: { peer2: 'bea' } },
  ];
  const mine = [rival('r1', 'Dean', 'dean'), rival('r2', 'Bea', 'BEA')];
  const { linkedRivalIds, toAdd } = mergeIncomingLinks(mine, links, 'me', DIR);
  assert.deepEqual(toAdd, []);
  assert.equal(linkedRivalIds.size, 2);
  assert.equal(linkedRivalIds.get('r2'), 'me__peer2');
});

// --- buildDiscoveryList ---------------------------------------------------

const THEIRS = [
  { handle: 'bea', name: 'Bea', icon: '🐻' },
  { handle: 'susmabit', name: 'Nikita', icon: '🧍' },
  { handle: 'carl', name: 'Carl', icon: '🦁' },
];

test('buildDiscoveryList excludes me and rivals I already track', () => {
  const out = buildDiscoveryList(THEIRS, 'susmabit', [rival('r1', 'Carl', 'carl')]);
  assert.deepEqual(out, [{ handle: 'bea', name: 'Bea', icon: '🐻' }]);
});

test('buildDiscoveryList compares by handleKey, not raw strings', () => {
  const out = buildDiscoveryList(THEIRS, 'https://maptap.gg/u/SusMaBit',
    [rival('r1', 'Carl', '@CARL')]);
  assert.deepEqual(out.map(p => p.handle), ['bea']);
});

test('buildDiscoveryList preserves the peer list order', () => {
  const out = buildDiscoveryList(THEIRS, 'nobody', []);
  assert.deepEqual(out.map(p => p.handle), ['bea', 'susmabit', 'carl']);
});

test('buildDiscoveryList dedupes repeated handles in a peer doc', () => {
  const noisy = [
    { handle: 'bea', name: 'Bea', icon: '🐻' },
    { handle: 'BEA', name: 'Bea again', icon: '🐻' },
  ];
  assert.deepEqual(buildDiscoveryList(noisy, 'me', []).map(p => p.name), ['Bea']);
});

test('buildDiscoveryList drops entries with no handle', () => {
  const noisy = [{ name: 'Ghost', icon: '👻' }, { handle: '', name: 'Blank' }];
  assert.deepEqual(buildDiscoveryList(noisy, 'me', []), []);
});

test('buildDiscoveryList returns [] for an empty or missing peer list', () => {
  assert.deepEqual(buildDiscoveryList([], 'me', []), []);
  assert.deepEqual(buildDiscoveryList(null, 'me', null), []);
});

test('buildDiscoveryList caps names the same way the published doc does', () => {
  const out = buildDiscoveryList([{ handle: 'bea', name: 'B'.repeat(200) }], 'me', []);
  assert.equal(out[0].name.length, MAX_NAME_LEN);
});

test('buildDiscoveryList empties out once every suggestion has been added', () => {
  const mine = THEIRS.map((p, i) => rival('r' + i, p.name, p.handle));
  assert.deepEqual(buildDiscoveryList(THEIRS, 'me', mine), []);
});
