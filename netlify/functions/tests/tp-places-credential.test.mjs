import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlacesKey } from '../tp-places.mjs';

// WHICH CREDENTIAL MAY BE USED, AND FROM WHERE.
//
// The 850/month guard only governs calls that go through the guarded function.
// On 2026-08-18 two paths were verified to bypass it:
//
//   1. Netlify keeps every deploy permalink alive forever, and an old deploy
//      runs OLD code against the LIVE config blob. A production permalink from
//      before the budget shipped still answered tp-places and still resolved
//      the key - unguarded billable calls for anyone who knows a deploy URL.
//   2. The laptop's .env held the SAME key as production (verified by hash),
//      so local runs billed the shared card into a throwaway local counter.
//
// The fix for (1) is that the field name is a VERSION GATE: old code reads
// `placesKey`, new code reads `placesKeyV2`, so removing the old field from the
// blob turns every previously deployed version into a permanent 503. The fix
// for (2) is that an env key needs an explicit spend opt-in and is no longer
// the production credential. These tests pin both.

test('the production credential comes from placesKeyV2', () => {
  assert.equal(resolvePlacesKey({ placesKeyV2: 'new-key' }, {}), 'new-key');
});

test('the OLD placesKey field is dead and can never configure the endpoint', () => {
  // This is the assertion that keeps every historical deploy switched off.
  // If it ever fails, old permalinks can bill the card again.
  assert.equal(resolvePlacesKey({ placesKey: 'old-key' }, {}), '');
  assert.equal(resolvePlacesKey({ placesKey: 'old-key' }, { TP_PLACES_KEY: 'x' }), '');
  // and it must not win, or even contribute, when both fields are present
  assert.equal(resolvePlacesKey({ placesKey: 'old-key', placesKeyV2: 'new-key' }, {}), 'new-key');
});

test('a local key alone does not spend: it needs the explicit opt-in', () => {
  assert.equal(resolvePlacesKey({}, { TP_PLACES_KEY: 'dev-key' }), '');
  assert.equal(resolvePlacesKey({}, { TP_PLACES_KEY: 'dev-key', TP_PLACES_ALLOW_LOCAL_SPEND: '0' }), '');
  assert.equal(resolvePlacesKey({}, { TP_PLACES_KEY: 'dev-key', TP_PLACES_ALLOW_LOCAL_SPEND: 'true' }), '',
    'only the exact string "1" opts in, so a stray truthy value cannot bill the card');
  assert.equal(resolvePlacesKey({}, { TP_PLACES_KEY: 'dev-key', TP_PLACES_ALLOW_LOCAL_SPEND: '1' }), 'dev-key');
});

test('the opt-in alone, with no key, configures nothing', () => {
  assert.equal(resolvePlacesKey({}, { TP_PLACES_ALLOW_LOCAL_SPEND: '1' }), '');
});

test('production always wins over a local key, so a laptop cannot shadow it', () => {
  assert.equal(
    resolvePlacesKey({ placesKeyV2: 'prod' }, { TP_PLACES_KEY: 'dev', TP_PLACES_ALLOW_LOCAL_SPEND: '1' }),
    'prod');
});

test('nothing configured is the safe default, whatever junk arrives', () => {
  for (const cfg of [null, undefined, {}, { placesKeyV2: '' }, { placesKeyV2: 42 }, { placesKeyV2: null }]) {
    assert.equal(resolvePlacesKey(cfg, {}), '', 'cfg ' + JSON.stringify(cfg));
  }
  assert.equal(resolvePlacesKey({}, null), '');
  assert.equal(resolvePlacesKey({}, undefined), '');
});
