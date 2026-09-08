'use strict';

// Accessible chart equivalents (2026-09-05 audit F16).
//
// A <canvas> is a picture. Chart.js is handed labels, datasets and tooltip
// callbacks and draws them; none of it reaches the accessibility tree, so the
// only route to a plotted value was hovering a point with a mouse. An axe
// pass over both pages was clean the whole time, because axe checks the
// markup that IS there - which is the coverage limit the audit was pointing
// at, not an axe bug.
//
// The load-bearing property, and the reason these live next to the helper
// rather than in each app: the text and the table are derived from the SAME
// series object handed to Chart.js, in the same call, so a filter change
// cannot leave them describing the previous view.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../chart-a11y.js');

const CONFIG = {
  type: 'line',
  data: {
    labels: ['Mon', 'Tue', 'Wed', 'Thu'],
    datasets: [
      { label: 'You', data: [700, 850, 800, 900] },
      { label: 'Ari', data: [720, 700, 810, 760] },
    ],
  },
};

test('the label names the chart and states its shape', () => {
  const d = A.describeConfig(CONFIG, { title: 'Score over time', axis: 'Date' });
  assert.match(d.label, /^Score over time: 2-series chart of 4 points\./);
});

test('the summary carries the values a hover tooltip would have', () => {
  const d = A.describeConfig(CONFIG, { title: 'Score over time', axis: 'Date' });
  // Values over 100 round to whole numbers: a chart summary that says
  // "average 812.5" is precision the eye never had off the picture.
  assert.match(d.summary, /You: 700 to 900 \(up 200\), low 700, high 900, average 813/);
  assert.match(d.summary, /Ari: 720 to 760 \(up 40\), low 700, high 810, average 748/);
});

test('the table is the series, in order, one column per dataset', () => {
  const d = A.describeConfig(CONFIG, { title: 'Score over time', axis: 'Date' });
  assert.deepEqual(d.columns, ['Date', 'You', 'Ari']);
  assert.deepEqual(d.rows, [
    ['Mon', '700', '720'],
    ['Tue', '850', '700'],
    ['Wed', '800', '810'],
    ['Thu', '900', '760'],
  ]);
});

test('a flat series says so rather than inventing a direction', () => {
  const d = A.describeConfig(
    { data: { labels: ['a', 'b'], datasets: [{ label: 'S', data: [5, 5] }] } },
    { title: 'T' }
  );
  assert.match(d.summary, /S: 5 to 5 \(level\)/);
});

test('gaps in a series are gaps, not zeroes', () => {
  // A null in Chart.js is a break in the line. Rendering it as 0 in the table
  // would be a different chart.
  const d = A.describeConfig(
    { data: { labels: ['a', 'b', 'c'], datasets: [{ label: 'S', data: [10, null, 30] }] } },
    { title: 'T' }
  );
  assert.deepEqual(d.rows, [['a', '10'], ['b', ''], ['c', '30']]);
  assert.match(d.summary, /S: 10 to 30 \(up 20\), low 10, high 30, average 20/);
});

test('an empty series is described as empty, never as a crash', () => {
  const d = A.describeConfig({ data: { labels: [], datasets: [{ label: 'S', data: [] }] } }, { title: 'T' });
  assert.match(d.summary, /S: no data/);
  assert.deepEqual(d.rows, []);
  assert.doesNotThrow(() => A.describeConfig({}, { title: 'T' }));
  assert.doesNotThrow(() => A.describeConfig(null, { title: 'T' }));
});

test('{x, y} point objects are read as their y value', () => {
  const d = A.describeConfig(
    { data: { datasets: [{ label: 'S', data: [{ x: 1, y: 4 }, { x: 2, y: 6 }] }] } },
    { title: 'T' }
  );
  assert.deepEqual(d.rows, [['1', '4'], ['2', '6']]);
});

test('summariseSeries handles one point without claiming a trend', () => {
  assert.equal(A.summariseSeries('S', [42]), 'S: 42');
});

// ---------------------------------------------------------------- the DOM ---

/** Minimal document stand-in: enough of createElement/append/query for attach. */
function fakeDom() {
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      attributes: {},
      className: '',
      textContent: '',
      scope: '',
      id: '',
      parentElement: null,
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k]; },
      appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
      remove() {
        if (!this.parentElement) return;
        const i = this.parentElement.children.indexOf(this);
        if (i >= 0) this.parentElement.children.splice(i, 1);
      },
      querySelector(sel) {
        const m = /^\[data-chart-a11y="(.+)"\]$/.exec(sel);
        const want = m ? m[1] : null;
        const walk = (node) => {
          for (const c of node.children) {
            if (want && c.attributes['data-chart-a11y'] === want) return c;
            const hit = walk(c);
            if (hit) return hit;
          }
          return null;
        };
        return walk(this);
      },
      text() {
        return this.textContent + this.children.map((c) => c.text()).join(' ');
      },
    };
    return el;
  };
  return { make, document: { createElement: make } };
}

function attachInto() {
  const { make, document } = fakeDom();
  global.document = document;
  const card = make('div');
  const wrap = card.appendChild(make('div'));
  const canvas = wrap.appendChild(make('canvas'));
  canvas.id = 'chart-trend';
  return { card, canvas };
}

test('attach gives the canvas a role and a describing label', (t) => {
  t.after(() => { delete global.document; });
  const { canvas } = attachInto();
  A.attach(canvas, CONFIG, { title: 'Score over time', axis: 'Date' });
  assert.equal(canvas.getAttribute('role'), 'img');
  assert.match(canvas.getAttribute('aria-label'), /Score over time: 2-series chart of 4 points/);
  assert.match(canvas.getAttribute('aria-label'), /You: 700 to 900/);
});

test('attach adds ONE keyboard-reachable disclosure holding the table', (t) => {
  t.after(() => { delete global.document; });
  const { card, canvas } = attachInto();
  A.attach(canvas, CONFIG, { title: 'Score over time', axis: 'Date' });
  const details = card.querySelector('[data-chart-a11y="chart-trend"]');
  assert.ok(details, 'a <details> is added');
  assert.equal(details.tagName, 'DETAILS', '<details><summary> is focusable and Enter-activated for free');
  assert.equal(details.children[0].tagName, 'SUMMARY');
  assert.match(details.children[0].textContent, /Chart data \(4 rows\)/);
  assert.match(details.text(), /Mon/);
  assert.match(details.text(), /900/);
});

test('re-attaching REPLACES it, so a filter change cannot leave two tables', (t) => {
  // The whole reason the table is built from the chart's own config: after a
  // filter, the picture and the text must be the same view or neither.
  t.after(() => { delete global.document; });
  const { card, canvas } = attachInto();
  A.attach(canvas, CONFIG, { title: 'Score over time', axis: 'Date' });
  A.attach(canvas, {
    data: { labels: ['Fri'], datasets: [{ label: 'You', data: [100] }] },
  }, { title: 'Score over time', axis: 'Date' });

  const found = card.children.filter((c) => c.attributes['data-chart-a11y'] === 'chart-trend');
  assert.equal(found.length, 1, 'exactly one disclosure, not one per render');
  assert.match(found[0].text(), /Fri/);
  assert.equal(/Mon/.test(found[0].text()), false, 'the previous view is gone');
  assert.match(canvas.getAttribute('aria-label'), /1 point/);
});

test('attach never throws on a missing canvas', () => {
  assert.doesNotThrow(() => A.attach(null, CONFIG, { title: 'T' }));
});
