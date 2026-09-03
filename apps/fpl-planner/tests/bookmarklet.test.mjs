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

// Objects the bookmarklet builds carry the vm realm's prototypes, so a strict
// deepEqual rejects structurally identical arrays. Everything it returns is
// pure data; compare that.
const json = (value) => JSON.stringify(value);

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

// A fifteen the team half accepts: 1..11 start, 12..15 on the bench, and both
// armbands on the pitch. Every malformed case below is a mutation of it, so a
// refusal names the field that was broken rather than "the payload".
const OK_TEAM = { xi: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], bench: [12, 13, 14, 15], captain: 5, vice: 6, chip: null };

const raw = (over = {}) => JSON.stringify({
  v: 2, entry: 1, event: 1, chip: null, transfers: [], team: OK_TEAM, ...over,
});
const withTeam = (over) => raw({ team: { ...OK_TEAM, ...over } });

// A whole plan, the shape the planner actually emits.
const fullPlan = (over = {}) => ({
  gw: 5,
  chip: null,
  transferCount: 1,
  transfersOut: [30],
  transfersIn: [11],
  startingXI: OK_TEAM.xi.slice(),
  bench: { gk: 12, order: [13, 14, 15] },
  captain: 5,
  viceCaptain: 6,
  ...over,
});

const CASES = [
  { name: 'a real plan', text: encodeHandoff(buildHandoff({ plan: fullPlan(), teamId: '4231987' }).payload) },
  { name: 'a wildcard plan', text: encodeHandoff(buildHandoff({ plan: fullPlan({ chip: 'wildcard' }), teamId: '9' }).payload) },
  { name: 'a bench boost plan', text: encodeHandoff(buildHandoff({ plan: fullPlan({ chip: 'bboost' }), teamId: '9' }).payload) },
  { name: 'a plan that rolls its transfer', text: raw() },
  { name: 'empty', text: '' },
  { name: 'whitespace', text: '   ' },
  { name: 'not json', text: 'copy me' },
  { name: 'an array', text: '[]' },
  { name: 'a future version', text: raw({ v: 3 }) },
  { name: 'the version before this one', text: raw({ v: 1 }) },
  { name: 'no entry', text: raw({ entry: 0 }) },
  { name: 'a fractional entry', text: raw({ entry: 1.5 }) },
  { name: 'a string entry', text: raw({ entry: '7' }) },
  { name: 'no event', text: raw({ event: null }) },
  { name: 'a bench boost on the transfers endpoint', text: raw({ chip: 'bboost' }) },
  { name: 'an invented chip', text: raw({ chip: 'megaboost' }) },
  { name: 'transfers not a list', text: raw({ transfers: {} }) },
  { name: 'a non-object transfer', text: raw({ transfers: [5] }) },
  { name: 'a half transfer', text: raw({ transfers: [{ out: 30 }] }) },
  { name: 'a self transfer', text: raw({ transfers: [{ out: 3, in: 3 }] }) },
  { name: 'a repeated seller', text: raw({ transfers: [{ out: 30, in: 3 }, { out: 30, in: 4 }] }) },
  { name: 'a player sold and bought', text: raw({ transfers: [{ out: 30, in: 4 }, { out: 5, in: 30 }] }) },
  { name: 'a purchase left out of the fifteen', text: raw({ transfers: [{ out: 30, in: 31 }] }) },
  { name: 'a sale still in the fifteen', text: raw({ transfers: [{ out: 5, in: 30 }] }) },
  { name: 'no team at all', text: raw({ team: undefined }) },
  { name: 'a team that is a list', text: raw({ team: [] }) },
  { name: 'ten starters', text: withTeam({ xi: OK_TEAM.xi.slice(0, 10) }) },
  { name: 'no starters at all', text: withTeam({ xi: null }) },
  { name: 'three substitutes', text: withTeam({ bench: [12, 13, 14] }) },
  { name: 'a squad place with no player', text: withTeam({ bench: [12, 13, 14, null] }) },
  { name: 'the same player twice', text: withTeam({ bench: [12, 13, 14, 11] }) },
  { name: 'no armband', text: withTeam({ captain: null }) },
  { name: 'one player wearing both armbands', text: withTeam({ captain: 5, vice: 5 }) },
  { name: 'a captain on the bench', text: withTeam({ captain: 13 }) },
  { name: 'a wildcard on the team endpoint', text: withTeam({ chip: 'wildcard' }) },
  { name: 'an invented team chip', text: withTeam({ chip: 'megaboost' }) },
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
    plan: fullPlan({ chip: 'freehit', transferCount: 3, transfersOut: [30, 31, 32], transfersIn: [9, 10, 11] }),
    teamId: '4231987',
  });
  assert.equal(built.ok, true, built.reason);
  const decoded = bm.decodeHandoff(encodeHandoff(built.payload));
  assert.equal(decoded.ok, true, decoded.reason);
  assert.equal(decoded.payload.entry, 4231987);
  assert.equal(decoded.payload.event, 5);
  assert.equal(decoded.payload.chip, 'freehit');
  assert.equal(decoded.payload.transfers.length, 3);
  assert.equal(decoded.payload.team.captain, 5);
  assert.equal(decoded.payload.team.bench.length, 4);
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
    // The limits the formation is checked against are FPL's own, read from the
    // payload rather than written down in the bookmarklet.
    element_types: [
      { id: 1, plural_name_short: 'GKP', squad_min_play: 1, squad_max_play: 1 },
      { id: 2, plural_name_short: 'DEF', squad_min_play: 3, squad_max_play: 5 },
      { id: 3, plural_name_short: 'MID', squad_min_play: 2, squad_max_play: 5 },
      { id: 4, plural_name_short: 'FWD', squad_min_play: 1, squad_max_play: 3 },
    ],
    teams,
    game_settings: { squad_team_limit: 3 },
    ...(overrides.bootstrap || {}),
  };

  const byId = Object.fromEntries(elements.map((el) => [el.id, el]));
  const myTeam = {
    picks: SQUAD_ORDER.map((id, i) => ({
      element: id,
      position: i + 1,
      selling_price: byId[id].now_cost - 1,
      purchase_price: byId[id].now_cost - 2,
      is_captain: id === 113,
      is_vice_captain: id === 114,
    })),
    transfers: { bank: 100, limit: 1, made: 0, cost: 4, value: 1000 },
    ...(overrides.myTeam || {}),
  };

  return { bootstrap, myTeam };
}

// The squad as FPL orders it: keeper, ten outfielders, reserve keeper, three
// outfield substitutes. 3-4-3, which the element_types above allow.
const BASE_XI = [101, 103, 104, 105, 108, 109, 110, 111, 113, 114, 115];
const BASE_BENCH = [102, 106, 107, 112];
const SQUAD_ORDER = [...BASE_XI, ...BASE_BENCH];

// The team half that goes with a given set of transfers: whoever arrives takes
// the slot of whoever he replaced, armbands included. The two halves of a
// payload have to describe one squad, so a fixture that builds them separately
// would be testing something the planner never emits.
const teamFor = (transfers, extra = {}) => {
  const swap = new Map(transfers.map((t) => [t.out, t.in]));
  const at = (id) => (swap.has(id) ? swap.get(id) : id);
  return {
    xi: BASE_XI.map(at),
    bench: BASE_BENCH.map(at),
    captain: at(113),
    vice: at(114),
    chip: null,
    ...extra,
  };
};

const payloadOf = (transfers, extra = {}) => {
  const { team, ...rest } = extra;
  return { v: 2, entry: 4231987, event: 5, chip: null, transfers, team: teamFor(transfers, team), ...rest };
};

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

/* --------------------------------------------- buildTeamSubmission */

const teamBuild = (transfers, extra = {}, over = {}) => {
  const { bootstrap, myTeam } = fixture(over);
  return bm.buildTeamSubmission({ payload: payloadOf(transfers, extra), myTeam, bootstrap });
};

test('the eleven, the bench and the armbands become the picks FPL saves', () => {
  const built = teamBuild([]);
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.body.picks.length, 15);
  assert.equal(built.body.chip, null);
  assert.equal(json(built.body.picks.map((p) => p.element)), json(SQUAD_ORDER));
  assert.equal(json(built.body.picks.map((p) => p.position)), json([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
  assert.equal(json(built.body.picks.filter((p) => p.is_captain).map((p) => p.element)), json([113]));
  assert.equal(json(built.body.picks.filter((p) => p.is_vice_captain).map((p) => p.element)), json([114]));
});

test('positions come from FPL element types, not from the order in the payload', () => {
  // The planner's startingXI is in no particular order, and FPL wants the
  // keeper in slot 1 with the outfielders behind him by position.
  const shuffled = [115, 108, 101, 114, 109, 103, 110, 104, 111, 113, 105];
  const built = teamBuild([], { team: { xi: shuffled } });
  assert.equal(built.ok, true, built.reason);
  const order = built.body.picks.map((p) => p.element);
  assert.equal(order[0], 101, 'slot 1 is the goalkeeper');
  assert.equal(json(order.slice(1, 4)), json([103, 104, 105]), 'defenders next, in the order the plan gave them');
  assert.equal(json(order.slice(4, 8)), json([108, 109, 110, 111]));
  assert.equal(json(order.slice(8, 11)), json([115, 114, 113]));
  assert.equal(json(order.slice(11)), json(BASE_BENCH), 'the reserve keeper holds slot 12');
});

test('a chip played by saving the team travels on that body', () => {
  const built = teamBuild([], { team: { chip: 'bboost' } });
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.body.chip, 'bboost');
  assert.equal(built.summary.chip, 'bboost');
});

test('a fifteen that is not the squad these transfers leave you with is refused', () => {
  // The likeliest real failure: the plan was built, then the manager made a
  // transfer of their own on FPL.
  const stale = teamBuild([], { team: { xi: [204, ...BASE_XI.slice(1)] } });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /not in the squad these transfers leave you with/);
  assert.match(stale.reason, /SpareFwd/, 'the refusal names the player, not an element id');

  const applied = teamBuild([{ out: 108, in: 203 }]);
  assert.equal(applied.ok, true, applied.reason);
  assert.ok(applied.body.picks.some((p) => p.element === 203));
  assert.ok(!applied.body.picks.some((p) => p.element === 108));
});

test('an illegal formation is refused against FPL own published limits', () => {
  // Two defenders and five midfielders: legal arithmetic, illegal football.
  const built = teamBuild([], { team: { xi: [101, 103, 104, 108, 109, 110, 111, 112, 113, 114, 115] } });
  assert.equal(built.ok, false);
  assert.match(built.reason, /starts 2 DEF and Fantasy Premier League needs at least 3/);
});

test('an outfielder in the reserve keeper slot is refused', () => {
  const built = teamBuild([], { team: { bench: [106, 102, 107, 112] } });
  assert.equal(built.ok, false);
  assert.match(built.reason, /first substitute in this plan is not a goalkeeper/);
});

test('an empty squad from FPL is refused by the team half too', () => {
  const { bootstrap } = fixture();
  const built = bm.buildTeamSubmission({ payload: payloadOf([]), myTeam: { picks: [], transfers: {} }, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /no squad/);
});

test('the confirm summary says what changes, in the squad FPL currently holds', () => {
  // 112 comes off the bench for 111, and the armband moves.
  const xi = [101, 103, 104, 105, 108, 109, 110, 112, 113, 114, 115];
  const bench = [102, 106, 107, 111];
  const built = teamBuild([], { team: { xi, bench, captain: 115, vice: 114 } });
  assert.equal(built.ok, true, built.reason);
  const s = built.summary;
  assert.equal(json(s.promoted), json(['Owned11']), 'element 112 is Owned11');
  assert.equal(json(s.benched), json(['Owned10']), 'element 111 is Owned10');
  assert.equal(s.captainChanged, true);
  assert.equal(s.captainWas, 'Owned12');
  assert.equal(s.captain, 'Owned14');
  assert.equal(s.viceChanged, false);
  assert.equal(s.unchanged, false);
});

test('a plan that changes nothing says so rather than pretending to act', () => {
  const built = teamBuild([]);
  assert.equal(built.summary.unchanged, true);
  assert.equal(built.summary.lineupChanged, false);
  assert.equal(json(built.summary.promoted), '[]');
  assert.equal(json(built.summary.benched), '[]');
});

test('a bench reorder is reported even though nobody leaves the pitch', () => {
  const built = teamBuild([], { team: { bench: [102, 107, 106, 112] } });
  assert.equal(built.summary.benchReordered, true);
  assert.equal(built.summary.unchanged, false);
});

/* ------------------------------------------------- buildApplication */

test('a plan with no transfers skips the transfer request and still sets the team', () => {
  const { bootstrap, myTeam } = fixture();
  const built = bm.buildApplication({ payload: payloadOf([]), myTeam, bootstrap });
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.transfers, null, 'nothing to buy means nothing to POST to the transfers endpoint');
  assert.ok(built.team.body.picks.length, 15);
  assert.equal(built.entry, 4231987);
  assert.equal(built.event, 5);
});

test('a roll for the wrong gameweek is refused even with no transfers to check', () => {
  const { bootstrap, myTeam } = fixture();
  const built = bm.buildApplication({ payload: payloadOf([], { event: 4 }), myTeam, bootstrap });
  assert.equal(built.ok, false);
  assert.match(built.reason, /Gameweek 4.*Gameweek 5/s);

  const closed = fixture();
  closed.bootstrap.events = closed.bootstrap.events.map((e) => ({ ...e, is_next: false }));
  const shut = bm.buildApplication({ payload: payloadOf([]), myTeam: closed.myTeam, bootstrap: closed.bootstrap });
  assert.equal(shut.ok, false);
  assert.match(shut.reason, /no gameweek open/);
});

test('both halves are built before either is sent', () => {
  const { bootstrap, myTeam } = fixture();
  const built = bm.buildApplication({ payload: payloadOf([{ out: 108, in: 203 }]), myTeam, bootstrap });
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.transfers.body.transfers[0].element_in, 203);
  assert.ok(built.team.body.picks.some((p) => p.element === 203));
});

test('a refusal in either half stops the whole thing', () => {
  const { bootstrap, myTeam } = fixture();
  // The transfer is legal; the team it describes is not.
  const bad = bm.buildApplication({
    payload: payloadOf([{ out: 108, in: 203 }], { team: { xi: [101, 103, 104, 203, 109, 110, 111, 112, 113, 114, 115] } }),
    myTeam,
    bootstrap,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /needs at least 3/);

  // And the other way round: an unaffordable transfer never reaches the team.
  const poor = fixture({ myTeam: { transfers: { bank: 10, limit: 1, made: 0 } } });
  const broke = bm.buildApplication({ payload: payloadOf([{ out: 108, in: 203 }]), myTeam: poor.myTeam, bootstrap: poor.bootstrap });
  assert.equal(broke.ok, false);
  assert.match(broke.reason, /more than you have/);
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
