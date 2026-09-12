import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGeminiKey } from '../tp-assist.mjs';

// WHICH CREDENTIAL MAY CONFIGURE THE ASSISTANT, AND FROM WHERE.
//
// The sibling rule, and the reason it exists, is written out in
// tp-places-credential.test.mjs: Netlify keeps every deploy permalink alive
// forever, and an old deploy runs OLD code against the LIVE config blob. So a
// permalink from before any guard shipped keeps answering, and keeps resolving
// whatever field name it knows about, for anyone who has the URL. The origin
// check is forgeable and is documented as defence-in-depth only.
//
// tp-places closed that in one move by renaming the field to `placesKeyV2`.
// tp-assist never did: `git log -S geminiKey` shows the name unchanged since
// the three-tier assistant shipped, so every historical deploy of this
// function could still reach Gemini on the owner's key. These tests pin the
// same gate here. The whole value of it is that there is NO fallback to the
// old name: once `geminiKey` is removed from the config blob, every version
// ever deployed before this change resolves nothing and answers 503 forever.

test('the production credential comes from geminiKeyV2', () => {
  assert.equal(resolveGeminiKey({ geminiKeyV2: 'new-key' }, {}), 'new-key');
});

test('the OLD geminiKey field is dead and can never configure the endpoint', () => {
  // This is the assertion that keeps every historical deploy switched off. If
  // it ever fails, an old permalink can spend the owner's Gemini quota again.
  assert.equal(resolveGeminiKey({ geminiKey: 'old-key' }, {}), '');
  assert.equal(resolveGeminiKey({ geminiKey: 'old-key' }, { TP_GEMINI_KEY: '' }), '');
  // and it must not win, or even contribute, when both fields are present
  assert.equal(resolveGeminiKey({ geminiKey: 'old-key', geminiKeyV2: 'new-key' }, {}), 'new-key');
});

test('the local-development env key still works, and production still wins over it', () => {
  // Unlike tp-places this needs no second spend opt-in, and deliberately so:
  // the Places key bills a card per call, while a local assistant turn spends
  // a fraction of a cent of the owner's own Gemini allowance. The property
  // that matters for the version gate is unaffected either way - deployed
  // functions on this site get NO env vars injected (verified), so the env
  // path cannot re-open a permalink.
  assert.equal(resolveGeminiKey({}, { TP_GEMINI_KEY: 'dev-key' }), 'dev-key');
  assert.equal(resolveGeminiKey({ geminiKeyV2: 'prod' }, { TP_GEMINI_KEY: 'dev' }), 'prod');
});

test('nothing configured is the safe default, whatever junk arrives', () => {
  for (const cfg of [null, undefined, {}, { geminiKeyV2: '' }, { geminiKeyV2: 42 }, { geminiKeyV2: null }]) {
    assert.equal(resolveGeminiKey(cfg, {}), '', 'cfg ' + JSON.stringify(cfg));
  }
  assert.equal(resolveGeminiKey({}, null), '');
  assert.equal(resolveGeminiKey({}, undefined), '');
});
