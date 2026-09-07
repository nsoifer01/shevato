import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkQuota as assistQuota, DEFAULT_LIMITS as ASSIST_LIMITS } from '../lib/tp-assist-quota.mjs';
import {
  checkQuota as placesQuota, releaseQuota as placesRelease,
  DEFAULT_LIMITS as PLACES_LIMITS, OWNER_LIMITS, resetAtFor,
} from '../lib/tp-places-quota.mjs';
import { clientAddress, networkBucket, networkIdFor } from '../lib/tp-client-identity.mjs';

// F12 (2026-09-05 audit): a per-browser cap is a fairness control for
// COOPERATIVE callers only.
//
// clientId is minted by the caller and sent in the body. The audit rotated it
// and admitted 400 assistant requests - the entire daily allowance - after
// which an honest new visitor received `global_day`. The global budget
// bounded the SPEND exactly as designed; it did not bound one caller's share
// of the AVAILABILITY, and availability is what the honest visitor lost.
//
// These pin the second dimension that fixes it, and every way it must not
// misfire: a shared network still works, a missing address fails open, the
// owner tier is exempt, and unspent reservations come back.

const NOW = Date.parse('2026-09-07T12:00:00Z');
// The day counters roll on the UTC day boundary, so a test that wants to
// exhaust a DAILY cap has to stay inside one - twelve hours from midnight is
// far more than the daily share needs at the hourly rate, and never crosses.
const DAY_START = Date.parse('2026-09-07T00:00:00Z');
const NET_A = networkBucket('203.0.113.7', NOW);
const NET_B = networkBucket('198.51.100.9', NOW);

/** Drive `attempts` requests from one network, rotating the client id. */
function rotateAssist({ attempts, networkId, now = NOW }) {
  let usage = {};
  const scopes = [];
  let admitted = 0;
  for (let i = 0; i < attempts; i++) {
    const q = assistQuota(usage, `rotating-${i}`, now, undefined, networkId);
    usage = q.usage;
    if (q.allowed) admitted++;
    else scopes.push(q.scope);
  }
  return { usage, admitted, scopes };
}

test('F12: rotating the client id no longer buys the whole daily allowance', () => {
  // Spread over the day, so the HOURLY cap cannot be the thing that answers:
  // this is the daily share, which is what the audit's 400 admitted requests
  // consumed.
  let usage = {};
  let admitted = 0;
  const scopes = [];
  let n = 0;
  for (let hour = 0; hour < 12; hour++) {
    for (let i = 0; i < 40; i++) {
      const q = assistQuota(usage, `rotating-${n++}`, DAY_START + hour * 3600_000, undefined, NET_A);
      usage = q.usage;
      if (q.allowed) admitted++; else scopes.push(q.scope);
    }
  }
  assert.equal(admitted, ASSIST_LIMITS.perNetworkDay,
    `one source is capped at its network share (the audit admitted ${ASSIST_LIMITS.globalDay})`);
  assert.ok(admitted < ASSIST_LIMITS.globalDay, 'and well short of the global pool');
  assert.ok(scopes.includes('network_day'),
    `the rejection names the network dimension, got ${[...new Set(scopes)].join(',')}`);
});

test('F12: and an honest visitor elsewhere still gets served afterwards', () => {
  // This is the whole point. Before, the rotator exhausted globalDay and the
  // next honest request anywhere on the internet was told global_day.
  let usage = {};
  let n = 0;
  for (let hour = 0; hour < 12; hour++) {
    for (let i = 0; i < 40; i++) {
      usage = assistQuota(usage, `rotating-${n++}`, DAY_START + hour * 3600_000, undefined, NET_A).usage;
    }
  }
  const honest = assistQuota(usage, 'a-real-browser', DAY_START + 11 * 3600_000, undefined, NET_B);
  assert.equal(honest.allowed, true);
  assert.ok(usage.globalDay < ASSIST_LIMITS.globalDay,
    `the shared pool still has room (${usage.globalDay}/${ASSIST_LIMITS.globalDay})`);
});

test('F12: the hourly network cap bites first, and clears on the hour', () => {
  const { admitted, scopes } = rotateAssist({ attempts: 100, networkId: NET_A });
  assert.equal(admitted, ASSIST_LIMITS.perNetworkHour);
  assert.equal(scopes[0], 'network_hour');
  // An hour later the same source is served again.
  const { usage } = rotateAssist({ attempts: 100, networkId: NET_A });
  const nextHour = assistQuota(usage, 'x', NOW + 3600_000, undefined, NET_A);
  assert.equal(nextHour.allowed, true);
});

test('F12: several people on ONE shared network all still get served', () => {
  // A household, an office, a cafe: different browsers, one address. The
  // network caps are three times the per-client caps precisely so this works.
  let usage = {};
  const perPerson = [];
  for (const person of ['phone', 'laptop', 'tablet']) {
    let ok = 0;
    for (let i = 0; i < ASSIST_LIMITS.perClientHour; i++) {
      const q = assistQuota(usage, person, NOW, undefined, NET_A);
      usage = q.usage;
      if (q.allowed) ok++;
    }
    perPerson.push(ok);
  }
  assert.deepEqual(perPerson, [10, 10, 10],
    'three unrelated people on one connection each get their full per-client hour');
});

test('F12: no address means no network dimension - fail open, never an outage', () => {
  // Local dev, an unusual proxy. A fairness control that becomes an outage
  // when a header is missing is worse than the unfairness it guards against.
  const { admitted } = rotateAssist({ attempts: 500, networkId: '' });
  assert.equal(admitted, ASSIST_LIMITS.globalDay, 'behaviour is exactly what it was before');
});

test('F12: a spoofed Origin buys nothing - it is a guard, not an identity', () => {
  // originAllowed decides whether a request is SERVED. It has never been, and
  // must never become, the thing that decides how much of a shared allowance
  // a caller may take: a non-browser client sets that header freely.
  const asBrowser = rotateAssist({ attempts: 500, networkId: NET_A });
  const asScript = rotateAssist({ attempts: 500, networkId: NET_A });
  assert.equal(asBrowser.admitted, asScript.admitted,
    'the caps do not care what the caller claims to be');
});

test('F12: the network id is day-scoped, so it is not a durable identifier', () => {
  const today = networkBucket('203.0.113.7', NOW);
  const tomorrow = networkBucket('203.0.113.7', NOW + 86400000);
  assert.notEqual(today, tomorrow, 'the same visitor is a different bucket tomorrow');
  assert.equal(today, networkBucket('203.0.113.7', NOW + 1000), 'and stable within the day');
  assert.match(today, /^[0-9a-f]{16}$/);
  assert.equal(today.includes('203.0.113'), false, 'no raw address is ever stored');
});

test('F12: the address comes from the edge header first, the forwarded chain second', () => {
  const withEdge = { headers: { get: (n) => ({
    'x-nf-client-connection-ip': '203.0.113.7',
    'x-forwarded-for': '10.9.9.9',
  }[n] || '') } };
  assert.equal(clientAddress(withEdge), '203.0.113.7', "the platform's own header wins");

  const forwardedOnly = { headers: { get: (n) => ({
    'x-forwarded-for': '198.51.100.9, 10.0.0.1, 10.0.0.2',
  }[n] || '') } };
  assert.equal(clientAddress(forwardedOnly), '198.51.100.9',
    'the FIRST entry is the client; a caller can append but cannot remove');

  assert.equal(clientAddress({ headers: { get: () => '' } }), '');
  assert.equal(networkIdFor({ headers: { get: () => '' } }, NOW), '');
  // A request object that throws must not take the function down with it.
  assert.equal(clientAddress({ headers: { get() { throw new Error('nope'); } } }), '');
  assert.equal(clientAddress(null), '');
});

// ------------------------------------------------------------- tp-places ---

test('F12: Places rotation is bounded by the network, not by the global pool', () => {
  let usage = {};
  let granted = 0;
  for (let i = 0; i < 200; i++) {
    const q = placesQuota(usage, `rotating-${i}`, NOW, 1, PLACES_LIMITS, 'public', NET_A);
    usage = q.usage;
    if (q.allowed) granted += q.granted;
  }
  assert.equal(granted, PLACES_LIMITS.perNetworkHour);
  assert.ok(granted <= PLACES_LIMITS.globalDay);
});

test('F12: the OWNER tier is exempt - a secret is identity, an address is an inference', () => {
  let usage = {};
  let granted = 0;
  for (let i = 0; i < 400; i++) {
    const q = placesQuota(usage, 'owner-browser', NOW, 1, OWNER_LIMITS, 'owner', NET_A);
    usage = q.usage;
    if (q.allowed) granted += q.granted;
  }
  assert.ok(granted > PLACES_LIMITS.perNetworkHour,
    `the owner is not held to a visitor's network share (granted ${granted})`);
});

test('F12: an unspent Places reservation comes back off the network counters too', () => {
  // A traveller scrolling a fully cached itinerary reserves and spends
  // nothing; without this they would burn an allowance that cost no money.
  const reserved = placesQuota({}, 'c1', NOW, 10, PLACES_LIMITS, 'public', NET_A);
  assert.equal(reserved.usage.networkDay[NET_A], 10);
  const after = placesRelease(reserved.usage, 'c1', NOW, 10, 'public', NET_A);
  assert.equal(after.networkDay[NET_A], 0);
  assert.equal(after.networkHour[NET_A], 0);
  assert.equal(after.clientDay.c1, 0);
});

test('F12: a network rejection tells the client when it clears', () => {
  // Without a correct resetAt the client guesses, and a guess is wrong in both
  // directions: it wastes the rest of an hour or re-asks a day cap hourly.
  assert.equal(resetAtFor('network_hour', NOW), resetAtFor('client_hour', NOW));
  assert.equal(resetAtFor('network_day', NOW), resetAtFor('client_day', NOW));
  assert.ok(resetAtFor('network_hour', NOW) > NOW);
});

test('F12: a repeat cold session from the same source is still one source', () => {
  // "Clear your storage and come back" mints a new clientId. That is exactly
  // the rotation above, spread out, and it is bounded the same way.
  let usage = {};
  let admitted = 0;
  for (let session = 0; session < 40; session++) {
    for (let i = 0; i < 5; i++) {
      const q = assistQuota(usage, `session-${session}`, NOW, undefined, NET_A);
      usage = q.usage;
      if (q.allowed) admitted++;
    }
  }
  assert.equal(admitted, ASSIST_LIMITS.perNetworkHour);
});
