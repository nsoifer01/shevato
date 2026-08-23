'use strict';

// The streaming-provider vocabulary is a single module on purpose: build-data.js
// normalizes with it, render-show-page.js renders the static pages from it, and
// js/app.js displays cards, rows, the season modal and the "Watch on" links from
// it. Before that, the app carried its own copy of the mainstream list, so the
// two could drift on the exact surface they were supposed to agree about.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../scripts/providers-lib.js');
const { normalizeProvider, normalizeProviders, isMainstreamProvider, MAINSTREAM_PROVIDERS } = providers;

test('normalizeProvider collapses TMDB plan and channel variants to the brand', () => {
  assert.equal(normalizeProvider('Netflix Standard with Ads'), 'Netflix');
  assert.equal(normalizeProvider('Peacock Premium Plus'), 'Peacock');
  assert.equal(normalizeProvider('HBO Max Amazon Channel'), 'HBO Max');
  assert.equal(normalizeProvider('Max'), 'HBO Max');
  assert.equal(normalizeProvider('Disney Plus'), 'Disney+');
  assert.equal(normalizeProvider('Paramount Plus'), 'Paramount+');
  assert.equal(normalizeProvider('Apple TV Plus'), 'Apple TV+');
});

test('normalizeProvider passes an unknown service through untouched', () => {
  assert.equal(normalizeProvider('Tubi'), 'Tubi');
  assert.equal(normalizeProvider('Britbox Apple TV Channel '), 'Britbox Apple TV Channel ');
});

test('normalizeProviders returns the display list: normalized, mainstream, deduped, in order', () => {
  // Sherlock's real TMDB list: 15 entries, three spellings of BritBox, one of
  // which carries a trailing space, plus PBS member stations.
  const sherlock = [
    'BritBox', 'BritBox Amazon Channel', 'Britbox Apple TV Channel ',
    'Thirteen', 'WETA+', 'KQED', 'Hulu',
  ];
  assert.deepEqual(normalizeProviders(sherlock), ['Hulu']);
  assert.deepEqual(
    normalizeProviders(['Netflix Standard with Ads', 'Netflix', 'Max', 'HBO Max', 'Disney Plus']),
    ['Netflix', 'HBO Max', 'Disney+'],
    'plan and brand variants collapse to one entry each, first-seen order kept',
  );
});

test('normalizeProviders never emits stray whitespace and tolerates junk input', () => {
  for (const p of normalizeProviders(['Britbox Apple TV Channel ', ' Netflix ', 'VIX '])) {
    assert.equal(p, p.trim());
  }
  assert.deepEqual(normalizeProviders(null), []);
  assert.deepEqual(normalizeProviders(undefined), []);
  assert.deepEqual(normalizeProviders([]), []);
  assert.deepEqual(normalizeProviders(['', 42, null, {}]), []);
});

test('isMainstreamProvider normalizes before deciding', () => {
  assert.equal(isMainstreamProvider('Netflix Standard with Ads'), true);
  assert.equal(isMainstreamProvider(' Max '), true, 'raw name, whitespace and all');
  assert.equal(isMainstreamProvider('Tubi'), false);
  assert.equal(isMainstreamProvider(null), false);
});

// The point of the module. These two assertions are what stops the app and the
// static pages from ever disagreeing again about which services a show names.
test('there is exactly one mainstream-provider definition in the app', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  assert.equal(
    /MAINSTREAM_PROVIDERS\s*=\s*new Set\(/.test(appJs), false,
    'js/app.js must not declare its own provider list; it reads window.RisingShowsProviders',
  );
  const rendererJs = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'render-show-page.js'), 'utf8',
  );
  assert.equal(
    /function normalizeProviders\s*\(/.test(rendererJs), false,
    'render-show-page.js must delegate to providers-lib, not reimplement the filter',
  );
});

test('index.html loads the shared vocabulary before app.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const lib = html.indexOf('scripts/providers-lib.js');
  const app = html.indexOf('js/app.js');
  assert.ok(lib > -1, 'providers-lib.js is loaded by the page');
  assert.ok(app > -1 && lib < app, 'and it is loaded before app.js');
});

test('the vocabulary is the set the pipeline and the pages both filter on', () => {
  assert.ok(MAINSTREAM_PROVIDERS instanceof Set);
  for (const name of ['Netflix', 'Hulu', 'Amazon Prime Video', 'HBO Max', 'Disney+',
    'Peacock', 'Paramount+', 'Apple TV+', 'Crunchyroll']) {
    assert.ok(MAINSTREAM_PROVIDERS.has(name), `${name} is part of the vocabulary`);
  }
  // Every entry survives its own normalization, so the set can be matched
  // against normalized names without a second pass. 'Max' is the deliberate
  // exception: it exists so a raw, unnormalized name still matches, and it
  // collapses to 'HBO Max'.
  for (const name of MAINSTREAM_PROVIDERS) {
    if (name === 'Max') continue;
    assert.equal(normalizeProvider(name), name, `${name} normalizes to itself`);
  }
});
