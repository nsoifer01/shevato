'use strict';

// The two curve renderers must plot the same curve.
//
// `scripts/render-curve.js` says so in its own header: "Server-side mirror of
// drawCurve() in js/app.js... Keep this in sync with the browser version's
// math". That instruction was the only thing enforcing it. Two independent
// implementations of the same geometry, kept in step by a comment, is the same
// shape as every other drift bug in this repo, and here it decides whether a
// static show page and the app draw the same line for the same season.
//
// What is pinned is the GEOMETRY, not the markup: the two emit different
// documents on purpose (the static one is a whole `<svg>` string with no
// client JS, the browser one fills in an existing `<svg>`'s children) and
// carry different DEFAULTS for padding. So both are driven with the SAME
// explicit geometry and compared on the path data they produce.
//
// Notably this also pins the rating window (`lo`/`hi`/`span`), which is the
// part that actually decides the curve's shape rather than its inset: widen
// it in one file and the same season reads as a different show on the two
// surfaces.
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderCurve } = require('../scripts/render-curve.js');
const { ctx } = require('./app-harness.js');

const W = 600;
const H = 200;
const PAD_X = 6;
// drawCurve() hardcodes padY = 6 and takes no option for it; render-curve.js
// takes one and defaults to 10, and the page builder does not pass it. So the
// two surfaces really do inset a season's curve differently today, by 4px at
// top and bottom. That is a cosmetic difference in a 220px-tall chart, not a
// disagreement about the maths, and closing it would repaint all ~34,700
// generated pages to no benefit. What must not drift is the FORMULA, so both
// are driven at the same padY and compared there.
const PAD_Y = 6;

/** A minimal `<svg>` that records the `d` its two paths are given. */
function recordingSvg() {
  const seen = {};
  const node = (key) => ({ setAttribute: (name, value) => { if (name === 'd') seen[key] = value; } });
  return {
    seen,
    querySelector(sel) {
      if (sel === '.curve-line') return node('line');
      if (sel === '.curve-area') return node('area');
      if (sel === '.curve-gap') return node('gap');
      return null; // no .curve-dots: the dots are markup, not geometry
    },
  };
}

/** The `d` of the line and area the BROWSER renderer draws. */
function browserPaths(episodes) {
  const svg = recordingSvg();
  // padX is the inset on both sides; the browser default differs from the
  // static one, so it is passed explicitly and so is padY's effect via H.
  // markGaps: the season modal draws with it, and the static renderer always does.
  ctx.drawCurve(svg, episodes, W, H, { padX: PAD_X, markGaps: true });
  return svg.seen;
}

/** The `d` of the line and area the STATIC renderer emits, pulled off its SVG string. */
function staticPaths(episodes) {
  const svg = renderCurve(episodes, { width: W, height: H, padX: PAD_X, padY: PAD_Y, showDots: false });
  const line = /class="curve-line"[^>]*\sd="([^"]+)"/.exec(svg) || /\sd="([^"]+)"[^>]*class="curve-line"/.exec(svg);
  const area = /class="curve-area"[^>]*\sd="([^"]+)"/.exec(svg) || /\sd="([^"]+)"[^>]*class="curve-area"/.exec(svg);
  const gap = /class="curve-gap"[^>]*\sd="([^"]+)"/.exec(svg);
  return { line: line && line[1], area: area && area[1], gap: gap ? gap[1] : '' };
}

const ep = (episode, rating) => ({ episode, rating, votes: 1000 });

const SEASONS = {
  'a rising season': [ep(1, 7.2), ep(2, 7.5), ep(3, 7.9), ep(4, 8.4), ep(5, 8.8)],
  'a flat season (span clamps to its floor)': [ep(1, 8.0), ep(2, 8.0), ep(3, 8.0)],
  'a season that touches both ends of the scale': [ep(1, 0.2), ep(2, 9.9), ep(3, 5.0)],
  'a two-episode season': [ep(1, 6.0), ep(2, 9.0)],
  'a single-episode season (xStep is zero)': [ep(1, 8.1)],
  'a season with a pre-season special': [ep(0, 6.5), ep(1, 8.0), ep(2, 8.3)],
  // Rated episode numbers that skip: General Hospital's 1-9, 17, 4480 ...
  'a season with unrated episodes between rated ones': [ep(1, 6.8), ep(2, 6.7), ep(9, 8.8), ep(17, 6.0), ep(4480, 6.3)],
};

for (const [name, episodes] of Object.entries(SEASONS)) {
  test(`${name}: both renderers plot the same line`, () => {
    const a = browserPaths(episodes);
    const b = staticPaths(episodes);
    assert.ok(b.line, 'the static renderer must emit a .curve-line path');
    assert.equal(a.line, b.line,
      'js/app.js drawCurve() and scripts/render-curve.js disagree on the line geometry.'
      + ' They are hand-synchronised mirrors: whichever one you changed, change the other.');
    assert.equal(a.area, b.area, 'and they disagree on the filled area');
    assert.equal(a.gap || '', b.gap, 'and on the dashed bridges over unrated episodes');
  });
}

test('the static renderer still draws nothing for an empty season, like the browser one', () => {
  // drawCurve() returns early rather than indexing points[0]; a failed detail
  // fetch is the path that reaches both with no episodes.
  const svg = recordingSvg();
  ctx.drawCurve(svg, [], W, H, { padX: PAD_X });
  assert.deepEqual(svg.seen, {}, 'the browser renderer must set no path for an empty season');
  assert.doesNotMatch(renderCurve([], { width: W, height: H }), /\sd="/, 'and neither must the static one');
});

test('a skip in episode numbers breaks the line and is bridged by a dashed gap path', () => {
  const eps = [ep(1, 6.8), ep(2, 6.7), ep(9, 8.8), ep(17, 6.0)];
  const { line, area, gap } = staticPaths(eps);
  assert.equal((line.match(/M/g) || []).length, 3, 'one run for 1-2, then a new run at 9 and at 17');
  assert.equal((area.match(/M/g) || []).length, 1, 'the area stays one shape');
  assert.equal((gap.match(/M/g) || []).length, 2, 'one bridge per skip');
  const consecutive = staticPaths([ep(1, 6.8), ep(2, 6.7), ep(3, 8.8)]);
  assert.equal(consecutive.gap, '', 'no skip, no gap path');
  assert.doesNotMatch(renderCurve([ep(1, 6.8), ep(2, 6.7)], { width: W, height: H }), /curve-gap/);
});
