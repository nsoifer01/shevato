'use strict';

// Unit tests for the rival-network pure core (js/network.js). No dates and no
// Firebase here on purpose: every function below is a deterministic transform
// of plain objects, which is exactly why they live outside app.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_NAME_LEN, MAX_HANDLE_LEN, MAX_ICON_LEN, MAX_PUBLISHED_RIVALS,
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

test('normalizeHandle finds the handle in every shape a profile link is pasted in', () => {
  // Whatever the user pastes into the username field has to resolve to the one
  // handle, or two people end up claiming two different doc ids for one
  // profile. The URL match is case-insensitive on the host and stops at the
  // first /, ? or #, so a trailing slash, a fragment, a query and surrounding
  // chat text all reduce to the same thing.
  assert.equal(normalizeHandle('HTTPS://MAPTAP.GG/u/Dean/'), 'Dean');
  assert.equal(normalizeHandle('https://maptap.gg/u/dean#history'), 'dean');
  assert.equal(normalizeHandle('look at maptap.gg/u/dean now'), 'dean');
  assert.equal(handleKey('HTTPS://MAPTAP.GG/u/Dean/'), handleKey('@dean'));
});

test('normalizeHandle: a bare @ or a non-string is no handle at all', () => {
  assert.equal(normalizeHandle('@ '), '');
  assert.equal(normalizeHandle(42), '42'); // coerced, not rejected
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

test('buildNetworkDoc caps icons, mine and every rival\'s', () => {
  // The icon cap is the one limit no other test asserted. 8 UTF-16 units is 4
  // emoji, which is the whole point of it being separate from the name cap.
  const doc = buildNetworkDoc({
    handle: 'susmabit',
    name: 'Nikita',
    icon: '🧍'.repeat(10),
    rivals: [rival('r1', 'Dean', 'dean', '🐺'.repeat(10))],
  });
  assert.equal(doc.icon.length, MAX_ICON_LEN);
  assert.equal(doc.icon, '🧍🧍🧍🧍');
  assert.equal(doc.rivals[0].icon.length, MAX_ICON_LEN);
});

test('buildNetworkDoc publishes an empty rival list rather than omitting the key', () => {
  // Joining before adding anyone still has to write a complete doc, otherwise
  // the peer read side has to special-case a missing `rivals`.
  assert.deepEqual(buildNetworkDoc({ handle: 'susmabit', name: 'Nikita' }),
    { handle: 'susmabit', name: 'Nikita', icon: '', rivals: [] });
  assert.deepEqual(buildNetworkDoc({ handle: 'susmabit', name: 'Nikita', rivals: 'nope' }).rivals, []);
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

test('mergeIncomingLinks caps a peer icon before it becomes a local rival', () => {
  const dir = { peer: { handle: 'Dean', name: 'Dean', icon: '🐺'.repeat(10) } };
  const { toAdd } = mergeIncomingLinks([], [LINK], 'me', dir);
  assert.equal(toAdd[0].icon.length, MAX_ICON_LEN);
});

test('mergeIncomingLinks connects the FIRST local rival when two share one handle', () => {
  // Nothing stops a user from adding the same MapTap profile as two rivals
  // (different display names, same username). The handle index keeps the first
  // one, so only that card shows the Connected chip and the duplicate stays
  // plain - and, importantly, the peer is NOT queued a third time as a new
  // rival. Pinned because "first wins" is the only stable answer here: the
  // alternative, marking both, would make deleting one of them ambiguous.
  const mine = [rival('r1', 'Dean', 'dean'), rival('r2', 'Dean (2nd account)', 'DEAN')];
  const { toAdd, linkedRivalIds } = mergeIncomingLinks(mine, [LINK], 'me', DIR);
  assert.deepEqual(toAdd, []);
  assert.deepEqual([...linkedRivalIds.entries()], [['r1', 'me__peer']]);
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

test('buildDiscoveryList caps icons the same way, splitting a surrogate pair if it must', () => {
  // The cap is a plain slice on UTF-16 units, so a mixed text/emoji icon can be
  // cut mid-pair and leave a lone surrogate. Not reachable from the app (the
  // icon picker emits one emoji), but it is what a hand-edited or imported
  // profile would publish, so the behavior is written down rather than assumed.
  const clean = buildDiscoveryList([{ handle: 'bea', name: 'Bea', icon: '🐻'.repeat(10) }], 'me', []);
  assert.equal(clean[0].icon, '🐻🐻🐻🐻');
  const split = buildDiscoveryList([{ handle: 'bea', name: 'Bea', icon: 'abc🐺🐺🐺' }], 'me', []);
  assert.equal(split[0].icon.length, MAX_ICON_LEN);
  assert.equal(split[0].icon.charCodeAt(7), 0xd83d); // high surrogate, no pair
});

test('buildDiscoveryList empties out once every suggestion has been added', () => {
  const mine = THEIRS.map((p, i) => rival('r' + i, p.name, p.handle));
  assert.deepEqual(buildDiscoveryList(THEIRS, 'me', mine), []);
});
