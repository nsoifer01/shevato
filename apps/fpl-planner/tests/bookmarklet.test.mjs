// The transfer bookmarklet, executed as the bytes a user actually installs.
//
// The subject here is js/ui/bookmarklet-url.js, not bookmarklet/fpl-transfer.js:
// the URL is decoded and run in a vm, so the comment strip and the URL encoding
// in scripts/build-bookmarklet.mjs are inside the test rather than trusted. A
// minifier that broke a string literal would fail here and not in production.
//
// The other job of this file is to pin the bookmarklet's private copy of the
// payload decoder against js/ui/handoff.js. The copy exists because a
// bookmarklet cannot import anything; every case below is asserted through BOTH
// decoders, verdict and wording, so the copy cannot quietly drift into
// accepting something the planner would refuse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { BOOKMARKLET_URL } from '../js/ui/bookmarklet-url.js';
import { SOURCE_PATH, toBookmarkletUrl } from '../scripts/build-bookmarklet.mjs';
import { encodeHandoff, decodeHandoff, buildHandoff } from '../js/ui/handoff.js';

/* ------------------------------------------------- load the shipped bytes */

const SHIPPED_SOURCE = decodeURIComponent(BOOKMARKLET_URL.slice('javascript:'.length));

function loadBookmarklet() {
  let exported = null;
  const context = vm.createContext({
    __FPL_BOOKMARKLET_EXPORT__: (api) => { exported = api; },
  });
  vm.runInContext(SHIPPED_SOURCE, context, { filename: 'bookmarklet-url.js' });
  assert.ok(exported, 'the bookmarklet did not reach its export hook');
  return exported;
}

const bm = loadBookmarklet();

/* ----------------------------------------------------------- the artifact */

test('the committed URL is what the current source generates', () => {
  // Editing bookmarklet/fpl-transfer.js without running the build script would
  // otherwise ship an old bookmarklet from a new-looking commit.
  assert.equal(
    BOOKMARKLET_URL,
    toBookmarkletUrl(readFileSync(SOURCE_PATH, 'utf8')),
    'run: node apps/fpl-planner/scripts/build-bookmarklet.mjs'
  );
});

test('the URL is a javascript: URL that evaluates to undefined', () => {
  assert.ok(BOOKMARKLET_URL.startsWith('javascript:'));
  // Without `void`, a bookmarklet whose expression returns a value navigates
  // the tab to that value instead of staying on the page.
  assert.ok(SHIPPED_SOURCE.startsWith('void '), 'the bookmarklet must be void-wrapped');
  const context = vm.createContext({ __FPL_BOOKMARKLET_EXPORT__: () => {} });
  assert.equal(vm.runInContext(SHIPPED_SOURCE, context), undefined);
});

test('the shipped bytes carry no comments and no origin literal', () => {
  assert.ok(!/^\s*\/\//m.test(SHIPPED_SOURCE), 'comment lines survived the strip');
  // It talks to FPL with relative paths only, which is what keeps it working
  // from that origin and keeps it off the site CSP inventory.
  assert.ok(!SHIPPED_SOURCE.includes('https://'), 'the bookmarklet must use relative paths');
});

/* --------------------------------------- the decoder, pinned to handoff.js */

const CASES = [
  { name: 'a real plan', text: encodeHandoff(buildHandoff({ plan: { gw: 5, chip: null, transfersOut: [11, 12], transfersIn: [21, 22] }, teamId: '4231987' }).payload) },
  { name: 'a wildcard plan', text: encodeHandoff(buildHandoff({ plan: { gw: 7, chip: 'wildcard', transfersOut: [1], transfersIn: [2] }, teamId: '9' }).payload) },
  { name: 'empty', text: '' },
  { name: 'whitespace', text: '   ' },
  { name: 'not json', text: 'copy me' },
  { name: 'an array', text: '[]' },
  { name: 'a future version', text: '{"v":2,"entry":1,"event":1,"chip":null,"transfers":[{"out":1,"in":2}]}' },
  { name: 'no entry', text: '{"v":1,"entry":0,"event":1,"chip":null,"transfers":[{"out":1,"in":2}]}' },
  { name: 'a fractional entry', text: '{"v":1,"entry":1.5,"event":1,"chip":null,"transfers":[{"out":1,"in":2}]}' },
  { name: 'a string entry', text: '{"v":1,"entry":"7","event":1,"chip":null,"transfers":[{"out":1,"in":2}]}' },
  { name: 'no event', text: '{"v":1,"entry":1,"event":null,"chip":null,"transfers":[{"out":1,"in":2}]}' },
  { name: 'a bench boost', text: '{"v":1,"entry":1,"event":1,"chip":"bboost","transfers":[{"out":1,"in":2}]}' },
  { name: 'an invented chip', text: '{"v":1,"entry":1,"event":1,"chip":"megaboost","transfers":[{"out":1,"in":2}]}' },
  { name: 'no transfers', text: '{"v":1,"entry":1,"event":1,"chip":null,"transfers":[]}' },
  { name: 'transfers not a list', text: '{"v":1,"entry":1,"event":1,"chip":null,"transfers":{}}' },
  { name: 'a non-object transfer', text: '{"v":1,"entry":1,"event":1,"chip":null,"transfers":[5]}' },
  { name: 'a half transfer', text: '{"v":1,"entry":1,"event":1,"chip":null,"transfers":[{"out":1}]}' },
  { name: 'a self transfer', text: '{"v":1,"entry":1,"event":1,"chip":null,"transfers":[{"out":3,"in":3}]}' },
  { name: 'a repeated seller', text: '{"v":1,"entry":1,"event":1,"chip":null,"transfers":[{"out":3,"in":4},{"out":3,"in":5}]}' },
  { name: 'a player sold and bought', text: '{"v":1,"entry":1,"event":1,"chip":null,"transfers":[{"out":3,"in":4},{"out":5,"in":3}]}' },
];

for (const testCase of CASES) {
  test(`both decoders agree on ${testCase.name}`, () => {
    const mine = decodeHandoff(testCase.text);
    const theirs = bm.decodeHandoff(testCase.text);
    assert.equal(theirs.ok, mine.ok);
    // The bookmarklet's objects are built in the vm's realm, so their
    // prototypes are not this realm's and a strict deepEqual would reject
    // structurally identical payloads. The payload is pure data; compare that.
    if (mine.ok) assert.equal(JSON.stringify(theirs.payload), JSON.stringify(mine.payload));
    else assert.equal(theirs.reason, mine.reason, 'the two decoders must refuse in the same words');
  });
}

test('the planner encodes something the bookmarklet accepts', () => {
  const built = buildHandoff({
    plan: { gw: 5, chip: 'freehit', transfersOut: [11, 12, 13], transfersIn: [21, 22, 23] },
    teamId: '4231987',
  });
  assert.equal(built.ok, true);
  const decoded = bm.decodeHandoff(encodeHandoff(built.payload));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.payload.entry, 4231987);
  assert.equal(decoded.payload.event, 5);
  assert.equal(decoded.payload.chip, 'freehit');
  assert.equal(decoded.payload.transfers.length, 3);
});

/* ------------------------------------------------------- buildSubmission */

// A squad of fifteen: elements 101..115, three per club across five clubs, in
// the 2/5/5/3 shape FPL requires.
const POSITIONS = [1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4];

function fixture(overrides = {}) {
  const elements = [];
  for (let i = 0; i < 15; i++) {
    const id = 101 + i;
    elements.push({
      id,
      web_name: `Owned${i}`,
      team: 1 + (i % 5),
      element_type: POSITIONS[i],
      now_cost: 50 + i,
    });
  }
  // Replacements to buy, one per position, on clubs 6 and 7.
  const spares = [
    { id: 201, web_name: 'SpareGkp', team: 6, element_type: 1, now_cost: 45 },
    { id: 202, web_name: 'SpareDef', team: 6, element_type: 2, now_cost: 55 },
    { id: 203, web_name: 'SpareMid', team: 7, element_type: 3, now_cost: 80 },
    { id: 204, web_name: 'SpareFwd', team: 7, element_type: 4, now_cost: 90 },
    { id: 205, web_name: 'ClubOneMid', team: 1, element_type: 3, now_cost: 60 },
  ];

  const teams = [];
  for (let t = 1; t <= 7; t++) teams.push({ id: t, name: `Club ${t}`, short_name: `C${t}` });

  const bootstrap = {
    events: [{ id: 4, is_next: false }, { id: 5, is_next: true }, { id: 6, is_next: false }],
    elements: [...elements, ...spares],
    teams,
    game_settings: { squad_team_limit: 3 },
    ...(overrides.bootstrap || {}),
  };

  const myTeam = {
    picks: elements.map((el, i) => ({
      element: el.id,
      position: i + 1,
      selling_price: el.now_cost - 1,
      purchase_price: el.now_cost - 2,
    })),
    transfers: { bank: 100, limit: 1, made: 0, cost: 4, value: 1000 },
    ...(overrides.myTeam || {}),
  };

  return { bootstrap, myTeam };
}

const payloadOf = (transfers, extra = {}) => ({
  v: 1, entry: 4231987, event: 5, chip: null, transfers, ...extra,
});

test('a legal transfer resolves to an FPL submission body', () => {
  const { bootstrap, myTeam } = fixture();
  // Swap a midfielder (element 108, now_cost 57, selling 56) for SpareMid (80).
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 203 }]), myTeam, bootstrap });
  assert.equal(built.ok, true, built.reason);
  assert.equal(JSON.stringify(built.body), JSON.stringify({
    chip: null,
    entry: 4231987,
    event: 5,
    transfers: [{ element_in: 203, element_out: 108, purchase_price: 80, selling_price: 56 }],
  }));
});

test('prices come from FPL, never from the plan', () => {
  const { bootstrap, myTeam } = fixture();
  // A hand-edited payload carrying its own prices must not influence anything.
  const payload = payloadOf([{ out: 108, in: 203, selling_price: 999, purchase_price: 1 }]);
  const built = bm.buildSubmission({ payload, myTeam, bootstrap });
  assert.equal(built.ok, true);
  assert.equal(built.body.transfers[0].selling_price, 56, 'selling price must come from my-team');
  assert.equal(built.body.transfers[0].purchase_price, 80, 'purchase price must come from bootstrap');
});

test('the bank is spent with the selling price, not the current price', () => {
  // Element 108 lists at 5.7 but sells for 5.6, and SpareMid costs 8.0. With
  // 1.0 in the bank that is 1.4 short; it would balance if the listed price
  // were what a sale returned, which is the mistake this guards.
  const poor = fixture({ myTeam: { transfers: { bank: 10, limit: 1, made: 0 } } });
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 203 }]), myTeam: poor.myTeam, bootstrap: poor.bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /£1\.4m more than you have/);

  const richer = fixture({ myTeam: { transfers: { bank: 30, limit: 1, made: 0 } } });
  const ok = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 203 }]), myTeam: richer.myTeam, bootstrap: richer.bootstrap });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.summary.bankBeforeTenths, 30);
  assert.equal(ok.summary.bankAfterTenths, 30 + 56 - 80);
});

test('a plan for the wrong gameweek is refused', () => {
  const { bootstrap, myTeam } = fixture();
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 203 }], { event: 4 }), myTeam, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /Gameweek 4.*Gameweek 5/s);
});

test('no open gameweek is refused rather than guessed', () => {
  const { bootstrap, myTeam } = fixture();
  bootstrap.events = bootstrap.events.map((e) => ({ ...e, is_next: false }));
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 203 }]), myTeam, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /no gameweek open/);
});

test('selling a player who is not in the squad is refused', () => {
  const { bootstrap, myTeam } = fixture();
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 204, in: 203 }]), myTeam, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /not in your squad/);
});

test('buying a player already owned is refused', () => {
  const { bootstrap, myTeam } = fixture();
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 109 }]), myTeam, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /already own/);
});

test('a transfer across positions is refused', () => {
  const { bootstrap, myTeam } = fixture();
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 204 }]), myTeam, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /different position/);
});

test('an unknown element is refused', () => {
  const { bootstrap, myTeam } = fixture();
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 9999 }]), myTeam, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /does not recognise/);
});

test('the club limit is checked before anything is sent, and names the club', () => {
  const { bootstrap, myTeam } = fixture({ myTeam: { transfers: { bank: 100, limit: 1, made: 0 } } });
  // Club 1 already holds elements 101, 106, 111; buying ClubOneMid (club 1)
  // for a club-2 midfielder would make four.
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 109, in: 205 }]), myTeam, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /4 players from Club 1.*limit is 3/);
});

test('the hit is computed from FPL own free-transfer counters', () => {
  const rich = { transfers: { bank: 100, limit: 1, made: 0 } };
  const { bootstrap, myTeam } = fixture({ myTeam: rich });
  const one = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 203 }]), myTeam, bootstrap });
  assert.equal(one.summary.estimatedHit, 0);

  const two = fixture({ myTeam: { transfers: { bank: 100, limit: 1, made: 0 } } });
  const both = bm.buildSubmission({
    payload: payloadOf([{ out: 108, in: 203 }, { out: 113, in: 204 }]),
    myTeam: two.myTeam,
    bootstrap: two.bootstrap,
  });
  assert.equal(both.ok, true, both.reason);
  assert.equal(both.summary.estimatedHit, bm.HIT_COST_POINTS);

  const already = fixture({ myTeam: { transfers: { bank: 100, limit: 2, made: 2 } } });
  const after = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 203 }]), myTeam: already.myTeam, bootstrap: already.bootstrap });
  assert.equal(after.summary.transfersAlreadyMade, 2);
  assert.equal(after.summary.estimatedHit, bm.HIT_COST_POINTS);
});

test('a chip week costs nothing and travels on the body', () => {
  const { bootstrap, myTeam } = fixture({ myTeam: { transfers: { bank: 100, limit: null, made: 0 } } });
  const built = bm.buildSubmission({
    payload: payloadOf([{ out: 108, in: 203 }, { out: 113, in: 204 }], { chip: 'wildcard' }),
    myTeam,
    bootstrap,
  });
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.body.chip, 'wildcard');
  assert.equal(built.summary.estimatedHit, 0);
  assert.equal(built.summary.freeTransfers, null);
});

test('an empty squad from FPL is refused', () => {
  const { bootstrap } = fixture();
  const built = bm.buildSubmission({ payload: payloadOf([{ out: 108, in: 203 }]), myTeam: { picks: [], transfers: {} }, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /no squad/);
});

/* -------------------------------------------------------------- the token */

test('the CSRF token is read out of the cookie jar', () => {
  assert.equal(bm.csrfFrom('csrftoken=abc123; sessionid=zzz'), 'abc123');
  assert.equal(bm.csrfFrom('sessionid=zzz; csrftoken=abc123'), 'abc123');
  assert.equal(bm.csrfFrom('sessionid=zzz'), null);
  assert.equal(bm.csrfFrom(''), null);
  assert.equal(bm.csrfFrom(null), null);
  // A prefix match would pick the wrong cookie up.
  assert.equal(bm.csrfFrom('xcsrftoken=nope'), null);
});

test('money renders in the millions FPL shows', () => {
  assert.equal(bm.money(56), '£5.6m');
  assert.equal(bm.money(0), '£0.0m');
  assert.equal(bm.money(-14), '-£1.4m');
});
