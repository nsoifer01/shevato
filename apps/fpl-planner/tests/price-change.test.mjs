// FPL's own price-change predictions: normalization, interpretation, and the
// bounded tie-break they are allowed to apply to a transfer decision.
//
// The fields are new and undocumented, so the normalization tests are mostly
// about REFUSING to invent data, and the interpretation tests are mostly about
// refusing to claim a move the game would not allow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState, normalizePriceChange } from '../js/engine/normalize.js';
import { buildRules } from '../js/engine/rules.js';
import {
  readPriceChange,
  priceUrgency,
  priceBadge,
  likelihoodTier,
  upcomingDeadlines,
  PRICE_CHANGE_THRESHOLD,
} from '../js/engine/price-change.js';
import { priceAdjustment, priceUrgencyCap, TRANSFER_DEFAULTS } from '../js/engine/transfers.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => JSON.parse(readFileSync(join(here, ...p), 'utf8'));

const bootstrap = read('fixtures', 'bootstrap.json');
const fixtures = read('fixtures', 'fixtures.json');

// The three windows FPL published on 2026-09-05, used verbatim so the offset
// -> wall-clock mapping is exercised against real data rather than a rounded
// invention.
const DEADLINES = [
  '2026-09-05T23:00:00Z',
  '2026-09-06T23:00:00Z',
  '2026-09-07T23:00:00Z',
];
// Everything that leaves the engine is canonical ISO (Date#toISOString), so the
// milliseconds are always present however the payload wrote the timestamp.
const CANON = DEADLINES.map(d => new Date(d).toISOString());
const NOW = Date.parse('2026-09-05T21:30:00Z');

// A raw bootstrap element carrying whatever price fields a test needs.
const rawElement = (over = {}) => ({
  price_change_percent: '84.0',
  price_change_hourly_rate: 640,
  price_change_projections: [
    { offset: 0, projected_percent: '112.0', likelihood: 5 },
    { offset: 1, projected_percent: '139.0', likelihood: 5 },
    { offset: 2, projected_percent: '166.0', likelihood: 5 },
  ],
  price_change_locked_until: null,
  price_change_calibrating: false,
  ...over,
});

// A normalized player, which is all readPriceChange ever sees.
const player = (over = {}) => ({ id: 1, webName: 'Test', priceChange: normalizePriceChange(rawElement(over)) });

// =========================================================== normalization ===

test('the official price-change fields survive normalization', () => {
  const pc = normalizePriceChange(rawElement());
  assert.equal(pc.progressPercent, 84);
  assert.equal(pc.calibrating, false);
  assert.equal(pc.lockedUntil, null);
  assert.equal(pc.projections.length, 3);
  assert.deepEqual(pc.projections[0], { offset: 0, projectedPercent: 112, likelihood: 5 });
});

test('strings are parsed to numbers exactly once, at the boundary', () => {
  const pc = normalizePriceChange(rawElement());
  assert.equal(typeof pc.progressPercent, 'number');
  for (const p of pc.projections) {
    assert.equal(typeof p.projectedPercent, 'number', 'projected_percent ships as a string');
    assert.equal(typeof p.likelihood, 'number');
  }
});

test('an element with no price fields at all normalizes to null, not to zeroes', () => {
  // SPEC: this is every payload recorded before 2026/27. Returning an object of
  // nulls would make "no data" indistinguishable from "no movement".
  assert.equal(normalizePriceChange({ id: 1, web_name: 'Old' }), null);
  assert.equal(normalizePriceChange(null), null);
  assert.equal(normalizePriceChange(undefined), null);
});

test('a partial payload keeps what it has instead of being discarded', () => {
  const pc = normalizePriceChange({ price_change_percent: '12.5' });
  assert.equal(pc.progressPercent, 12.5);
  assert.deepEqual(pc.projections, []);
});

test('malformed projection entries are dropped, never defaulted to zero', () => {
  // SPEC: an unreadable percent is not a projection of no movement. Defaulting
  // it would make the app state something FPL never said.
  const pc = normalizePriceChange(rawElement({
    price_change_projections: [
      { offset: 0, projected_percent: 'not-a-number', likelihood: 5 },
      { offset: 1, projected_percent: '139.0', likelihood: 5 },
      { offset: 'two', projected_percent: '166.0', likelihood: 5 },
      { offset: -1, projected_percent: '10.0', likelihood: 1 },
      { offset: 1.5, projected_percent: '10.0', likelihood: 1 },
      null,
      'garbage',
    ],
  }));
  assert.deepEqual(pc.projections, [{ offset: 1, projectedPercent: 139, likelihood: 5 }]);
});

test('projections are sorted by offset however the payload ordered them', () => {
  const pc = normalizePriceChange(rawElement({
    price_change_projections: [
      { offset: 2, projected_percent: '166.0', likelihood: 5 },
      { offset: 0, projected_percent: '112.0', likelihood: 5 },
      { offset: 1, projected_percent: '139.0', likelihood: 5 },
    ],
  }));
  assert.deepEqual(pc.projections.map(p => p.offset), [0, 1, 2]);
});

test('a duplicated offset is one window, not two', () => {
  const pc = normalizePriceChange(rawElement({
    price_change_projections: [
      { offset: 0, projected_percent: '112.0', likelihood: 5 },
      { offset: 0, projected_percent: '-50.0', likelihood: -1 },
    ],
  }));
  assert.equal(pc.projections.length, 1);
  assert.equal(pc.projections[0].projectedPercent, 112, 'the first entry wins');
});

test('an out-of-range likelihood is clamped rather than losing the projection', () => {
  // SPEC: a future API widening the scale must degrade to a conservative tier,
  // not to a missing prediction.
  const pc = normalizePriceChange(rawElement({
    price_change_projections: [
      { offset: 0, projected_percent: '112.0', likelihood: 99 },
      { offset: 1, projected_percent: '-112.0', likelihood: -99 },
    ],
  }));
  assert.equal(pc.projections[0].likelihood, 5);
  assert.equal(pc.projections[1].likelihood, -5);
});

test('a missing likelihood is null, and a projection with none still counts', () => {
  const pc = normalizePriceChange(rawElement({
    price_change_projections: [{ offset: 0, projected_percent: '112.0' }],
  }));
  assert.equal(pc.projections[0].likelihood, null);
  assert.equal(pc.projections[0].projectedPercent, 112);
});

test('an unparseable lock timestamp is dropped rather than kept as an invalid date', () => {
  assert.equal(normalizePriceChange(rawElement({ price_change_locked_until: 'soon' })).lockedUntil, null);
  const ok = normalizePriceChange(rawElement({ price_change_locked_until: '2026-09-12T14:30:08.374304Z' }));
  assert.equal(ok.lockedUntil, '2026-09-12T14:30:08.374Z');
});

test('the hourly rate is deliberately not carried', () => {
  // SPEC: its units did not reconcile with the published projections, so it is
  // read and dropped. Carrying it would invite extrapolation from it.
  const pc = normalizePriceChange(rawElement());
  assert.equal('hourlyRate' in pc, false);
  assert.equal(JSON.stringify(pc).includes('640'), false);
});

test('the shipped fixture has no price fields, and the whole world still builds', () => {
  // SPEC: the regression guard for every payload recorded before the feature
  // existed. A missing field must never throw or produce a fake prediction.
  const state = buildGameState(bootstrap, fixtures, { fetchedAt: '2026-08-10T12:00:00Z' });
  assert.equal(state.players.size, bootstrap.elements.length);
  for (const p of state.players.values()) assert.equal(p.priceChange, null);
});

// ================================================================== rules ===

test('the official price-change deadlines are parsed, sorted and normalized to ISO', () => {
  const rules = buildRules({
    ...bootstrap,
    game_config: {
      ...bootstrap.game_config,
      settings: {
        ...bootstrap.game_config.settings,
        price_change_deadlines: ['2026-09-07T23:00:00Z', '2026-09-05T23:00:00Z', 'nonsense'],
      },
    },
  });
  assert.deepEqual(rules.priceChangeDeadlines, [CANON[0], CANON[2]]);
});

test('a payload with no deadlines yields an empty list, never a hardcoded hour', () => {
  const rules = buildRules(bootstrap);
  assert.deepEqual(rules.priceChangeDeadlines, []);
});

test('upcomingDeadlines keeps only future windows, in time order', () => {
  assert.deepEqual(upcomingDeadlines(DEADLINES, NOW), CANON);
  const later = Date.parse('2026-09-06T12:00:00Z');
  assert.deepEqual(upcomingDeadlines(DEADLINES, later), CANON.slice(1));
  assert.deepEqual(upcomingDeadlines(null, NOW), []);
});

// ========================================================= interpretation ===

test('a projected rise tonight reads as a rise, tonight, at the official window', () => {
  const m = readPriceChange(player(), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.available, true);
  assert.equal(m.direction, 'rise');
  assert.equal(m.offset, 0);
  assert.equal(m.timing, 'tonight');
  assert.equal(m.projectedPercent, 112);
  assert.equal(m.tier, 'strong');
  assert.equal(m.changeAt, CANON[0], 'the time comes from FPL, not from assuming 23:00');
  assert.equal(m.displayable, true);
});

test('a projected fall tonight reads as a fall', () => {
  const m = readPriceChange(player({
    price_change_percent: '-84.0',
    price_change_projections: [{ offset: 0, projected_percent: '-112.0', likelihood: -5 }],
  }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.direction, 'fall');
  assert.equal(m.timing, 'tonight');
  assert.equal(m.tier, 'strong');
});

test('the EARLIEST crossing decides the timing, not the largest', () => {
  // SPEC: a bigger number two days out is not a reason to act tonight.
  const m = readPriceChange(player({
    price_change_projections: [
      { offset: 0, projected_percent: '40.0', likelihood: 1 },
      { offset: 1, projected_percent: '105.0', likelihood: 3 },
      { offset: 2, projected_percent: '300.0', likelihood: 5 },
    ],
  }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.offset, 1);
  assert.equal(m.timing, 'tomorrow');
  assert.equal(m.projectedPercent, 105);
  assert.equal(m.changeAt, CANON[1]);
});

test('a crossing two days out reads as two days out', () => {
  const m = readPriceChange(player({
    price_change_projections: [
      { offset: 0, projected_percent: '30.0', likelihood: 1 },
      { offset: 1, projected_percent: '60.0', likelihood: 1 },
      { offset: 2, projected_percent: '101.0', likelihood: 3 },
    ],
  }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.timing, 'in-2-days');
  assert.equal(m.offset, 2);
});

test('a player drifting in the middle gets no badge at all', () => {
  // SPEC: a badge on all 600 players is a badge on none of them.
  const m = readPriceChange(player({
    price_change_percent: '12.0',
    price_change_projections: [
      { offset: 0, projected_percent: '14.0', likelihood: 1 },
      { offset: 1, projected_percent: '20.0', likelihood: 1 },
      { offset: 2, projected_percent: '26.0', likelihood: 1 },
    ],
  }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.direction, 'none');
  assert.equal(m.displayable, false);
  assert.equal(priceBadge(m, 'in'), null);
});

test('a player with no price data at all is silent', () => {
  const m = readPriceChange({ id: 1, priceChange: null }, { now: NOW, deadlines: DEADLINES });
  assert.equal(m.available, false);
  assert.equal(m.displayable, false);
  assert.equal(priceBadge(m, 'in'), null);
  assert.equal(priceUrgency(m, 'in'), 0);
});

test('missing projections cannot produce a prediction from the progress alone', () => {
  // SPEC: progress at 99% is not a projection that it will cross.
  const m = readPriceChange(player({
    price_change_percent: '99.0',
    price_change_projections: [],
  }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.available, true);
  assert.equal(m.direction, 'none');
  assert.equal(m.progressPercent, 99);
  assert.equal(m.displayable, false);
});

test('the +-100 threshold is exclusive below and inclusive at the boundary', () => {
  const at = (v) => readPriceChange(player({
    price_change_projections: [{ offset: 0, projected_percent: String(v), likelihood: 3 }],
  }), { now: NOW, deadlines: DEADLINES });

  assert.equal(at(99.9).direction, 'none', 'just short is not a change');
  assert.equal(at(PRICE_CHANGE_THRESHOLD).direction, 'rise', 'exactly at the threshold counts');
  assert.equal(at(-PRICE_CHANGE_THRESHOLD).direction, 'fall');
  assert.equal(at(-99.9).direction, 'none');
});

// ------------------------------------------------------------------ locks ---

test('a live lock suppresses every window it covers', () => {
  // SPEC: FPL forbids the move, so the app must not promise it. The lock here
  // covers all three published windows.
  const m = readPriceChange(player({
    price_change_locked_until: '2026-09-12T14:30:00Z',
  }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.locked, true);
  assert.equal(m.direction, 'none', 'no move may be claimed under the lock');
  assert.equal(m.lockedUntil, '2026-09-12T14:30:00.000Z');
  // It is still worth a word, because the raw projection WOULD have crossed.
  assert.equal(m.displayable, true);
  assert.equal(priceBadge(m, 'in').kind, 'locked');
});

test('a lock that expires mid-window only suppresses the windows before it', () => {
  // SPEC: the gate is per-window, not all-or-nothing. A lock lifting tomorrow
  // morning still allows tomorrow night's change.
  const m = readPriceChange(player({
    price_change_locked_until: '2026-09-06T09:00:00Z',
  }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.locked, true);
  assert.equal(m.direction, 'rise');
  assert.equal(m.offset, 1, 'tonight is locked out; tomorrow is not');
  assert.equal(m.changeAt, CANON[1]);
});

test('an expired lock is history and gates nothing', () => {
  const m = readPriceChange(player({
    price_change_locked_until: '2026-09-01T00:00:00Z',
  }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.locked, false);
  assert.equal(m.lockedUntil, null);
  assert.equal(m.direction, 'rise');
  assert.equal(m.offset, 0);
});

test('under a live lock with no known windows, nothing is claimed', () => {
  // SPEC: without the deadline list we cannot prove a window falls after the
  // lock, and guessing would be the app promising an impossible move.
  const m = readPriceChange(player({
    price_change_locked_until: '2026-09-06T09:00:00Z',
  }), { now: NOW, deadlines: [] });
  assert.equal(m.direction, 'none');
  assert.equal(m.locked, true);
});

test('a locked player with nothing projected to cross stays silent', () => {
  const m = readPriceChange(player({
    price_change_locked_until: '2026-09-12T14:30:00Z',
    price_change_projections: [{ offset: 0, projected_percent: '3.0', likelihood: 0 }],
  }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.locked, true);
  assert.equal(m.displayable, false, 'a lock is only news when it suppresses something');
});

// ------------------------------------------------------------ calibrating ---

test('a calibrating prediction is shown, but never with a confidence tier', () => {
  const m = readPriceChange(player({ price_change_calibrating: true }), { now: NOW, deadlines: DEADLINES });
  assert.equal(m.calibrating, true);
  assert.equal(m.direction, 'rise');
  assert.equal(m.tier, null, 'FPL says it is not settled; the app must not say "strong"');
  assert.equal(m.tierLabel, null);
  const badge = priceBadge(m, 'in');
  assert.equal(badge.kind, 'calibrating');
  assert.equal(badge.urgent, false);
});

// --------------------------------------------------------------- the tier ---

test('likelihood maps to a tier word and is never a probability', () => {
  assert.equal(likelihoodTier(5).key, 'strong');
  assert.equal(likelihoodTier(-5).key, 'strong', 'the sign is direction, the magnitude is confidence');
  assert.equal(likelihoodTier(4).key, 'moderate');
  assert.equal(likelihoodTier(3).key, 'moderate');
  assert.equal(likelihoodTier(2).key, 'slight');
  assert.equal(likelihoodTier(1).key, 'slight');
  assert.equal(likelihoodTier(0), null, 'zero is no signal, not a weak one');
  assert.equal(likelihoodTier(null), null);
});

test('no tier label anywhere reads as a percentage', () => {
  for (const l of [-5, -3, -1, 1, 3, 5]) {
    const t = likelihoodTier(l);
    assert.equal(/%|\bpercent|\bprobabilit/i.test(t.label), false, `${t.label} must not imply a probability`);
  }
});

// ================================================================ badges ====

test('the badge names the direction and the timing in words', () => {
  const rise = priceBadge(readPriceChange(player(), { now: NOW, deadlines: DEADLINES }), 'in');
  assert.equal(rise.text, '↑ Rise tonight');
  assert.equal(rise.kind, 'rise');

  const fall = priceBadge(readPriceChange(player({
    price_change_projections: [{ offset: 1, projected_percent: '-140.0', likelihood: -5 }],
  }), { now: NOW, deadlines: DEADLINES }), 'out');
  assert.equal(fall.text, '↓ Fall tomorrow');
});

test('urgency is asymmetric: only buying a riser and selling a faller are urgent', () => {
  const rise = readPriceChange(player(), { now: NOW, deadlines: DEADLINES });
  const fall = readPriceChange(player({
    price_change_percent: '-84.0',
    price_change_projections: [{ offset: 0, projected_percent: '-112.0', likelihood: -5 }],
  }), { now: NOW, deadlines: DEADLINES });

  assert.equal(priceBadge(rise, 'in').urgent, true, 'buying a riser: waiting costs money');
  assert.equal(priceBadge(rise, 'out').urgent, false, 'selling a riser: useful, not urgent');
  assert.equal(priceBadge(fall, 'out').urgent, true, 'selling a faller: waiting loses value');
  assert.equal(priceBadge(fall, 'in').urgent, false, 'buying a faller: waiting may save money');
});

test('a locked or calibrating player can never be urgent', () => {
  const locked = readPriceChange(player({ price_change_locked_until: '2026-09-12T14:30:00Z' }), { now: NOW, deadlines: DEADLINES });
  const calib = readPriceChange(player({ price_change_calibrating: true }), { now: NOW, deadlines: DEADLINES });
  assert.equal(priceBadge(locked, 'in').urgent, false);
  assert.equal(priceBadge(calib, 'in').urgent, false);
  assert.equal(priceUrgency(locked, 'in'), 0);
  assert.equal(priceUrgency(calib, 'in'), 0);
});

test('urgency decays with distance and with confidence', () => {
  const at = (offset, likelihood) => priceUrgency(readPriceChange(player({
    price_change_projections: [{ offset, projected_percent: '112.0', likelihood }],
  }), { now: NOW, deadlines: DEADLINES }), 'in');

  assert.ok(at(0, 5) > at(1, 5), 'tonight beats tomorrow');
  assert.ok(at(1, 5) > at(2, 5), 'tomorrow beats two days out');
  assert.ok(at(0, 5) > at(0, 3), 'a strong signal beats a moderate one');
  assert.ok(at(0, 3) > at(0, 1));
  assert.equal(at(0, 0), 0, 'no signal moves nothing');
});

// ====================================================== the tie-break =======

const cfg = TRANSFER_DEFAULTS;
const CAP = priceUrgencyCap(cfg);

const modelFor = (over) => readPriceChange(player(over), { now: NOW, deadlines: DEADLINES });
const RISER = modelFor({});
const FALLER = modelFor({
  price_change_percent: '-84.0',
  price_change_projections: [{ offset: 0, projected_percent: '-112.0', likelihood: -5 }],
});
const FLAT = modelFor({
  price_change_percent: '2.0',
  price_change_projections: [{ offset: 0, projected_percent: '3.0', likelihood: 0 }],
});

test('the cap is derived from a margin the engine already trusts, not typed in', () => {
  assert.equal(CAP, cfg.priceUrgencyFraction * cfg.ftValuePoints);
  assert.equal(CAP, 0.12);
  assert.ok(CAP < cfg.hitMargin / 10, 'an order of magnitude below the smallest existing margin');
});

test('the adjustment can never exceed the cap, for any number of transfers', () => {
  // SPEC: this is the bound the whole design rests on. A two-transfer plan that
  // buys two risers and sells two fallers is the most extreme input there is.
  const models = new Map([
    [1, RISER], [2, RISER], [3, FALLER], [4, FALLER],
  ]);
  const adj = priceAdjustment([3, 4], [1, 2], models, cfg);
  assert.ok(Math.abs(adj) <= CAP + 1e-12, `${adj} must be within +-${CAP}`);
  assert.equal(adj, CAP, 'four aligned signals clamp to exactly the cap');
});

test('the roll is always exactly zero, so price can never invent a transfer', () => {
  // SPEC: the price signal may reorder transfers against each other. It may
  // never talk a manager into transferring when holding was the better plan.
  assert.equal(priceAdjustment([], [], new Map(), cfg), 0);
});

test('buying a riser is favoured; buying a faller is mildly discouraged', () => {
  const buyRiser = priceAdjustment([9], [1], new Map([[1, RISER], [9, FLAT]]), cfg);
  const buyFaller = priceAdjustment([9], [1], new Map([[1, FALLER], [9, FLAT]]), cfg);
  assert.ok(buyRiser > 0, 'act before the rise');
  assert.ok(buyFaller < 0, 'waiting might save money');
  assert.ok(Math.abs(buyFaller) < Math.abs(buyRiser), 'waiting is a weaker argument than paying more');
});

test('selling a faller is favoured; selling a riser is mildly discouraged', () => {
  const sellFaller = priceAdjustment([9], [1], new Map([[9, FALLER], [1, FLAT]]), cfg);
  const sellRiser = priceAdjustment([9], [1], new Map([[9, RISER], [1, FLAT]]), cfg);
  assert.ok(sellFaller > 0);
  assert.ok(sellRiser < 0);
  assert.ok(Math.abs(sellRiser) < Math.abs(sellFaller));
});

test('with no price data anywhere the adjustment is zero for every candidate', () => {
  // SPEC: the feature must be a strict no-op on a payload without the fields,
  // which is what makes it safe to ship against old fixtures and past seasons.
  const none = readPriceChange({ priceChange: null }, { now: NOW, deadlines: [] });
  const models = new Map([[1, none], [2, none], [9, none], [8, none]]);
  assert.equal(priceAdjustment([9], [1], models, cfg), 0);
  assert.equal(priceAdjustment([9, 8], [1, 2], models, cfg), 0);
});

test('a locked player contributes nothing to the decision even while it displays', () => {
  const locked = modelFor({ price_change_locked_until: '2026-09-12T14:30:00Z' });
  assert.equal(locked.displayable, true, 'the badge still appears');
  assert.equal(priceAdjustment([9], [1], new Map([[1, locked], [9, FLAT]]), cfg), 0);
});

test('sorting on the bounded key is a total order and only reorders near-ties', () => {
  // SPEC: the reason the implementation adds a bounded key instead of using a
  // "reorder if within epsilon" comparator, which is not transitive and makes
  // Array.sort implementation-defined.
  const mk = (score, adj) => ({ score, sortScore: score + adj });
  const clearly = mk(50, 0);            // clearly better on points, no price signal
  const marginal = mk(50 - 2 * CAP - 0.01, CAP); // maximum possible price help
  const sorted = [marginal, clearly].sort((a, b) => b.sortScore - a.sortScore);
  assert.equal(sorted[0], clearly, 'a clearly better plan cannot be displaced');

  const tied = mk(50 - 0.01, CAP);
  const resorted = [clearly, tied].sort((a, b) => b.sortScore - a.sortScore);
  assert.equal(resorted[0], tied, 'a near-tie is broken by the price signal');
});
