'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderCurve } = require('../scripts/render-curve.js');

const SAMPLE = [
  { episode: 1, rating: 7.0, votes: 1000 },
  { episode: 2, rating: 8.5, votes: 1200 },
  { episode: 3, rating: 9.0, votes: 1500 },
];

test('renderCurve emits a self-contained svg', () => {
  const svg = renderCurve(SAMPLE);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
});

test('renderCurve includes the line, area, and one dot per episode', () => {
  const svg = renderCurve(SAMPLE);
  assert.ok(svg.includes('class="curve-line"'));
  assert.ok(svg.includes('class="curve-area"'));
  const dotCount = (svg.match(/<circle /g) || []).length;
  assert.equal(dotCount, SAMPLE.length);
});

test('renderCurve embeds per-episode hover titles', () => {
  const svg = renderCurve(SAMPLE);
  assert.ok(svg.includes('Ep 1: 7.0'));
  assert.ok(svg.includes('Ep 2: 8.5'));
  assert.ok(svg.includes('Ep 3: 9.0'));
  assert.ok(svg.includes('1,000 votes'));
});

test('renderCurve escapes ampersands in tooltips', () => {
  const svg = renderCurve([
    { episode: 1, rating: 7.0, votes: 1, name: 'Tom & Jerry' },
  ]);
  // The name itself isn't in the tooltip, but the helper should escape any
  // & it does emit (the votes formatting can include thousands separators
  // that don't matter here; this guards against a regression if we ever add
  // the name to the tooltip).
  assert.ok(!svg.includes(' & '));
});

test('renderCurve handles a single-episode season without divide-by-zero', () => {
  const svg = renderCurve([{ episode: 1, rating: 8.0, votes: 100 }]);
  assert.ok(svg.includes('<circle'));
  // y must be a finite number
  assert.ok(/cy="[\d.]+"/.test(svg));
});

test('renderCurve returns an empty svg for no episodes', () => {
  const svg = renderCurve([]);
  assert.ok(svg.includes('<svg'));
  assert.ok(!svg.includes('<circle'));
});

test('renderCurve respects showDots=false', () => {
  const svg = renderCurve(SAMPLE, { showDots: false });
  assert.ok(!svg.includes('<circle'));
});
