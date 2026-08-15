// The hand-rolled charts, rendered with the real module under the mini DOM.
//
// The README's contract for ui/charts.js is that "every charted number also
// appears as text nearby", so a chart is never the only way to read a value.
// Inside this module that means the value is IN the rendered node as text (a
// cap, a tooltip line, an end label), not only encoded in a bar height or a
// path coordinate; the tests below assert exactly that, alongside the axis
// arithmetic that decides what the marks claim.
//
// The mini DOM has no layout, so nothing here measures pixels: heights and
// positions are asserted as the style strings the module computes, which is
// the whole of what it controls.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, walk, query, queryAll, textOf } from './helpers/mini-dom.mjs';

const teardownDom = installDom();
after(() => teardownDom());

const { compactNumber, columnChart, trendChart, sparkline } = await import('../js/ui/charts.js');

/* ---------------------------------------------------------- compactNumber */

test('compactNumber abbreviates ranks and ticks the way the axis needs', () => {
  assert.equal(compactNumber(1234567), '1.2M');
  assert.equal(compactNumber(45300), '45.3k');
  assert.equal(compactNumber(1000), '1k', 'a trailing .0 is dropped');
  assert.equal(compactNumber(2500000), '2.5M');
  assert.equal(compactNumber(12000000), '12M', 'past 10M the decimal is noise');
  assert.equal(compactNumber(250000), '250k', 'past 100k the decimal is noise');
  assert.equal(compactNumber(999), '999');
  assert.equal(compactNumber(0), '0');
  assert.equal(compactNumber(-45300), '-45.3k', 'a falling series keeps its sign');
});

test('compactNumber never invents a figure for a non-number', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null]) {
    assert.equal(compactNumber(bad), '-', String(bad));
  }
});

/* ----------------------------------------------------------- column chart */

const gwPoints = [
  { label: 'GW 1', value: 62 },
  { label: 'GW 2', value: 48, note: 'Wildcard' },
  { label: 'GW 3', value: 71, active: true },
];

test('a sparse column chart prints every value as text, not only as a height', () => {
  const chart = columnChart({ points: gwPoints, formatValue: (v) => `${v} pts` });
  const text = textOf(chart);
  for (const p of gwPoints) {
    assert.ok(text.includes(`${p.value} pts`), `"${p.value} pts" appears as text`);
    assert.ok(text.includes(p.label), `${p.label} appears as text`);
  }
  // The caps specifically: one per column when there is room for all of them.
  assert.deepEqual(queryAll(chart, 'fpl-col-cap').map(textOf), ['62 pts', '48 pts', '71 pts']);
  // And the note travels into the tooltip, so the story is readable too.
  assert.match(text, /Wildcard/);
});

test('column heights scale against the maximum from a shared zero baseline', () => {
  const chart = columnChart({ points: gwPoints });
  const fills = queryAll(chart, 'fpl-col-fill').map(n => n.getAttribute('style'));
  assert.equal(fills[2], `height:${(71 / 71) * 100}%`, 'the peak fills the track');
  assert.equal(fills[0], `height:${(62 / 71) * 100}%`);
  // A non-finite value renders no bar rather than a guessed one.
  const withHole = columnChart({ points: [...gwPoints, { label: 'GW 4', value: NaN }] });
  const holeFill = queryAll(withHole, 'fpl-col-fill')[3];
  assert.equal(holeFill.getAttribute('style'), 'height:0%');
});

test('a dense chart quiets the caps but every value is still text via its tooltip', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ label: `GW ${i + 1}`, value: 40 + i }));
  const chart = columnChart({ points: many, formatValue: (v) => `${v} pts` });
  assert.ok([...walk(chart)].length > 0);
  // Fewer caps than columns: only the peak and the newest carry one here.
  const caps = queryAll(chart, 'fpl-col-cap');
  assert.ok(caps.length < many.length, `dense chart shows ${caps.length} caps for ${many.length} columns`);
  // But the README claim holds regardless: every value is text somewhere in
  // the node, because every column carries a tooltip line.
  const text = textOf(chart);
  for (const p of many) assert.ok(text.includes(`${p.value} pts`), `${p.label} value readable`);
  // And the mark itself is focusable with the value in its accessible name.
  const cols = queryAll(chart, 'fpl-col');
  assert.equal(cols.length, many.length);
  for (const [i, col] of cols.entries()) {
    assert.equal(col.getAttribute('tabindex'), '0');
    assert.equal(col.getAttribute('aria-label'), `GW ${i + 1}: ${40 + i} pts`);
  }
});

/* ------------------------------------------------------------- trend line */

const trendPoints = [
  { label: 'GW 1', value: 1200000 },
  { label: 'GW 2', value: 900000, tooltip: 'Best week' },
  { label: 'GW 3', value: 1000000 },
];

test('a trend chart carries every value as text through its dots and end label', () => {
  const chart = trendChart({ points: trendPoints, formatValue: (v) => compactNumber(v) });
  // One hit-target dot per point, each with the value in its accessible name
  // and a tooltip whose first line is label · value, as real text.
  const dots = queryAll(chart, 'fpl-dot-hit');
  assert.equal(dots.length, trendPoints.length);
  assert.equal(dots[0].getAttribute('aria-label'), 'GW 1: 1.2M');
  const text = textOf(chart);
  for (const p of trendPoints) assert.ok(text.includes(compactNumber(p.value)), `${p.label} value readable`);
  assert.match(text, /Best week/, 'the per-point tooltip line is text too');
  // The newest value is also printed beside the line as the end label.
  assert.equal(textOf(query(chart, 'fpl-line-endlabel')), '1M');
});

test('the grid shows three ticks, top-down for a normal axis, flipped when inverted', () => {
  const normal = trendChart({ points: trendPoints, formatTick: (v) => String(Math.round(v)) });
  const normalTicks = queryAll(normal, 'fpl-line-tick').map(textOf).map(Number);
  assert.equal(normalTicks.length, 3);
  assert.ok(normalTicks[0] > normalTicks[2], 'max on top when up is good');

  // Overall rank: DOWN is the good direction, so the axis flips.
  const inverted = trendChart({ points: trendPoints, invert: true, formatTick: (v) => String(Math.round(v)) });
  const invertedTicks = queryAll(inverted, 'fpl-line-tick').map(textOf).map(Number);
  assert.ok(invertedTicks[0] < invertedTicks[2], 'min on top when down is good');
  // Same scale either way, read in opposite directions.
  assert.deepEqual([...invertedTicks].reverse(), normalTicks);
});

test('the x axis names the first and last points, and a single point sits mid-plot', () => {
  const chart = trendChart({ points: trendPoints });
  const xLabels = query(chart, 'fpl-line-x');
  assert.equal(textOf(xLabels), 'GW 1GW 3', 'first and last only; the dots carry the rest');
  const single = trendChart({ points: [{ label: 'GW 1', value: 5 }] });
  const dot = query(single, 'fpl-dot-hit');
  assert.match(dot.getAttribute('style'), /left:50%/, 'one point cannot span an axis');
});

/* -------------------------------------------------------------- sparkline */

test('a sparkline needs two finite values, otherwise it draws nothing at all', () => {
  assert.equal(sparkline({ values: [] }), null);
  assert.equal(sparkline({ values: [5] }), null);
  assert.equal(sparkline({ values: [5, NaN] }), null, 'one finite value is still not a line');
  assert.ok(sparkline({ values: [5, 7] }), 'two finite values are a line');
});

test('the sparkline marks the newest point and stays out of the accessibility tree', () => {
  const spark = sparkline({ values: [2, 4, 3], height: 44 });
  assert.equal(spark.getAttribute('aria-hidden'), 'true',
    'the caller prints the values beside it, so the drawing itself is decoration');
  assert.match(spark.getAttribute('style'), /height:44px/);
  const dot = query(spark, 'fpl-dot');
  assert.match(dot.getAttribute('style'), /left:100%/, 'the dot sits on the last point');
});
